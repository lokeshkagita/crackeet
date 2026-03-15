/**
 * Groq-only provider: Whisper for transcription + Groq LLM for response.
 * No Gemini/Gemma - only Groq API.
 */
const { getSystemPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn } = require('./gemini');
const { pcmToWavBuffer } = require('../audioUtils');
const { getGroqApiKey, getModelForToday, incrementCharUsage } = require('../storage');

let isGroqActive = false;
let currentSystemPrompt = null;
let groqConversationHistory = [];
let groqApiKey = '';

// VAD state
let isSpeaking = false;
let speechBuffers = [];
let silenceFrameCount = 0;
let speechFrameCount = 0;
let resampleRemainder = Buffer.alloc(0);

const VAD_CONFIG = { energyThreshold: 0.02, speechFramesRequired: 2, silenceFramesRequired: 15 };

function resample24kTo16k(inputBuffer) {
    const combined = Buffer.concat([resampleRemainder, inputBuffer]);
    const inputSamples = Math.floor(combined.length / 2);
    const outputSamples = Math.floor((inputSamples * 2) / 3);
    const outputBuffer = Buffer.alloc(outputSamples * 2);
    for (let i = 0; i < outputSamples; i++) {
        const srcPos = (i * 3) / 2;
        const srcIndex = Math.floor(srcPos);
        const frac = srcPos - srcIndex;
        const s0 = combined.readInt16LE(srcIndex * 2);
        const s1 = srcIndex + 1 < inputSamples ? combined.readInt16LE((srcIndex + 1) * 2) : s0;
        const interpolated = Math.round(s0 + frac * (s1 - s0));
        outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
    }
    const consumedInputSamples = Math.ceil((outputSamples * 3) / 2);
    const remainderStart = consumedInputSamples * 2;
    resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);
    return outputBuffer;
}

function calculateRMS(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    if (samples === 0) return 0;
    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = pcm16Buffer.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / samples);
}

function processVAD(pcm16kBuffer) {
    const rms = calculateRMS(pcm16kBuffer);
    const isVoice = rms > VAD_CONFIG.energyThreshold;
    if (isVoice) {
        speechFrameCount++;
        silenceFrameCount = 0;
        if (!isSpeaking && speechFrameCount >= VAD_CONFIG.speechFramesRequired) {
            isSpeaking = true;
            speechBuffers = [];
            sendToRenderer('update-status', 'Listening... (speech detected)');
        }
    } else {
        silenceFrameCount++;
        speechFrameCount = 0;
        if (isSpeaking && silenceFrameCount >= VAD_CONFIG.silenceFramesRequired) {
            isSpeaking = false;
            const audioData = Buffer.concat(speechBuffers);
            speechBuffers = [];
            handleSpeechEnd(audioData);
            return;
        }
    }
    if (isSpeaking) speechBuffers.push(Buffer.from(pcm16kBuffer));
}

async function transcribeWithGroqWhisper(pcm16kBuffer) {
    const wavBuffer = pcmToWavBuffer(pcm16kBuffer, 16000, 1, 16);
    const formData = new FormData();
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('response_format', 'text');
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqApiKey}` },
        body: formData,
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Groq Whisper: ${res.status} ${err}`);
    }
    return (await res.text()).trim();
}

function stripThinkingTags(text) {
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function sendToGroqLLM(transcription) {
    const modelToUse = getModelForToday();
    if (!modelToUse) {
        sendToRenderer('update-status', 'Groq limits reached for today');
        return;
    }
    groqConversationHistory.push({ role: 'user', content: transcription.trim() });
    if (groqConversationHistory.length > 20) groqConversationHistory = groqConversationHistory.slice(-20);
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${groqApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: modelToUse,
            messages: [
                { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
                ...groqConversationHistory,
            ],
            stream: true,
            temperature: 0.7,
            max_tokens: 1024,
        }),
    });
    if (!response.ok) throw new Error(`Groq: ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let isFirst = true;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter((l) => l.trim() !== '');
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const json = JSON.parse(data);
                    const token = json.choices?.[0]?.delta?.content || '';
                    if (token) {
                        fullText += token;
                        const displayText = stripThinkingTags(fullText);
                        if (displayText) {
                            sendToRenderer(isFirst ? 'new-response' : 'update-response', displayText);
                            isFirst = false;
                        }
                    }
                } catch (_) {}
            }
        }
    }
    const cleaned = stripThinkingTags(fullText);
    if (cleaned) {
        groqConversationHistory.push({ role: 'assistant', content: cleaned });
        const modelKey = modelToUse.split('/').pop();
        incrementCharUsage('groq', modelKey, transcription.length + cleaned.length);
        saveConversationTurn(transcription, cleaned);
    }
}

async function handleSpeechEnd(audioData) {
    if (!isGroqActive) return;
    if (audioData.length < 16000) {
        sendToRenderer('update-status', 'Listening...');
        return;
    }
    try {
        sendToRenderer('update-status', 'Transcribing...');
        const transcription = await transcribeWithGroqWhisper(audioData);
        if (!transcription || transcription.length < 2) {
            sendToRenderer('update-status', 'Listening...');
            return;
        }
        sendToRenderer('update-status', 'Generating response...');
        await sendToGroqLLM(transcription);
    } catch (err) {
        console.error('[GroqProvider] Error:', err);
        sendToRenderer('update-status', 'Error: ' + err.message);
    }
    sendToRenderer('update-status', 'Listening...');
}

function processGroqAudio(monoChunk24k) {
    if (!isGroqActive) return;
    const pcm16k = resample24kTo16k(monoChunk24k);
    if (pcm16k.length > 0) processVAD(pcm16k);
}

async function initializeGroqSession(profile = 'interview', customPrompt = '', language = 'en-US') {
    groqApiKey = getGroqApiKey();
    if (!groqApiKey || groqApiKey.trim() === '') {
        sendToRenderer('update-status', 'Groq API key required');
        return false;
    }
    sendToRenderer('session-initializing', true);
    currentSystemPrompt = getSystemPrompt(profile, customPrompt, false);
    initializeNewSession(profile, customPrompt);
    groqConversationHistory = [];
    isSpeaking = false;
    speechBuffers = [];
    silenceFrameCount = 0;
    speechFrameCount = 0;
    resampleRemainder = Buffer.alloc(0);
    isGroqActive = true;
    sendToRenderer('session-initializing', false);
    sendToRenderer('update-status', 'Groq ready - Listening...');
    return true;
}

function closeGroqSession() {
    isGroqActive = false;
    isSpeaking = false;
    speechBuffers = [];
    resampleRemainder = Buffer.alloc(0);
}

function isGroqSessionActive() {
    return isGroqActive;
}

async function sendGroqText(text) {
    if (!isGroqActive) return { success: false, error: 'No active Groq session' };
    try {
        await sendToGroqLLM(text);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

async function sendGroqImage(base64Data, prompt) {
    if (!groqApiKey || groqApiKey.trim() === '') {
        return { success: false, error: 'Groq API key required' };
    }
    const url = `data:image/png;base64,${base64Data}`;
    const userContent = [
        { type: 'text', text: prompt || 'Describe what you see in this image.' },
        { type: 'image_url', image_url: { url } },
    ];
    try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${groqApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: GROQ_VISION_MODEL,
                messages: [
                    { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant. Describe images accurately.' },
                    { role: 'user', content: userContent },
                ],
                temperature: 0.7,
                max_tokens: 1024,
            }),
        });
        if (!res.ok) {
            const err = await res.text();
            console.error(`[GroqProvider] Vision API error (${res.status}):`, err);
            // Parse error message if possible
            let errorMsg = err;
            try {
                const errJson = JSON.parse(err);
                errorMsg = errJson.error?.message || err;
            } catch (_) {}
            throw new Error(`Vision model '${GROQ_VISION_MODEL}' error: ${res.status} - ${errorMsg}`);
        }
        const json = await res.json();
        const text = json.choices?.[0]?.message?.content?.trim() || '';
        if (text) {
            sendToRenderer('new-response', text);
            if (isGroqActive) {
                groqConversationHistory.push({ role: 'user', content: `[Image] ${prompt || 'Describe image'}` });
                groqConversationHistory.push({ role: 'assistant', content: text });
            }
        }
        return { success: true, text, model: GROQ_VISION_MODEL };
    } catch (err) {
        console.error('[GroqProvider] Image error:', err);
        return { success: false, error: err.message };
    }
}

module.exports = {
    initializeGroqSession,
    processGroqAudio,
    closeGroqSession,
    isGroqSessionActive,
    sendGroqText,
    sendGroqImage,
};

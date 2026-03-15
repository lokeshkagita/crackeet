/**
 * Session Manager - validates session codes with backend
 * and retrieves Groq API keys for authorized sessions.
 */

// IMPORTANT: Change this to your deployed Vercel backend URL
const BACKEND_URL = 'https://your-crackit-backend.vercel.app';

async function validateSessionCode(code) {
    if (!code || code.trim() === '') {
        return { success: false, error: 'Session code is required' };
    }

    try {
        const response = await fetch(`${BACKEND_URL}/api/validate?code=${encodeURIComponent(code.trim().toUpperCase())}`);
        const data = await response.json();

        if (!response.ok) {
            return { success: false, error: data.error || 'Invalid session code' };
        }

        return {
            success: true,
            groqApiKey: data.groqApiKey,
            userName: data.userName || '',
        };
    } catch (err) {
        console.error('[SessionManager] Validation error:', err);
        return { success: false, error: 'Cannot reach server. Check your internet connection.' };
    }
}

function getBackendUrl() {
    return BACKEND_URL;
}

module.exports = { validateSessionCode, getBackendUrl };

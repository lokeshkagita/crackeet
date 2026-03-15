const { getRedis, generateSessionCode, verifyAdmin } = require('../../lib/redis');

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    if (!verifyAdmin(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { groqApiKey, userName } = req.body || {};
    if (!groqApiKey) {
        return res.status(400).json({ error: 'groqApiKey is required' });
    }

    try {
        const redis = getRedis();

        // Generate unique code
        let code;
        let exists = true;
        let attempts = 0;
        while (exists && attempts < 10) {
            code = generateSessionCode();
            try {
                exists = await redis.exists(`session:${code}`);
            } catch (e) {
                console.error('Redis exists check error:', e);
                break;
            }
            attempts++;
        }

        const session = {
            code,
            groqApiKey,
            userName: userName || '',
            active: true,
            createdAt: new Date().toISOString(),
            usedAt: null,
            disabledAt: null,
        };

        // Store session
        try {
            await redis.set(`session:${code}`, session);
        } catch (e) {
            console.error('Redis set error:', e);
            throw e;
        }

        // Add to sessions index
        try {
            await redis.sadd('sessions:all', code);
        } catch (e) {
            console.error('Redis sadd error:', e);
        }

        return res.status(201).json({
            success: true,
            sessionCode: code,
            userName: session.userName,
            createdAt: session.createdAt,
        });
    } catch (err) {
        console.error('Create session error:', err.message, err.stack);
        return res.status(500).json({ error: 'Server error', details: err.message });
    }
};

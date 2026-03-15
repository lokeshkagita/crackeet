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
        while (exists) {
            code = generateSessionCode();
            exists = await redis.exists(`session:${code}`);
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
        await redis.set(`session:${code}`, session);

        // Add to sessions index
        await redis.sadd('sessions:all', code);

        return res.status(201).json({
            success: true,
            sessionCode: code,
            userName: session.userName,
            createdAt: session.createdAt,
        });
    } catch (err) {
        console.error('Create session error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
};

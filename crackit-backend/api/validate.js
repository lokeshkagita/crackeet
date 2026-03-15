const { getRedis } = require('../lib/redis');

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'Session code required' });

    try {
        const redis = getRedis();
        const session = await redis.get(`session:${code.toUpperCase()}`);

        if (!session) {
            return res.status(404).json({ error: 'Invalid session code' });
        }

        if (!session.active) {
            return res.status(403).json({ error: 'Session has been disabled' });
        }

        // Mark session as used
        await redis.set(`session:${code.toUpperCase()}`, {
            ...session,
            usedAt: new Date().toISOString(),
        });

        return res.status(200).json({
            success: true,
            groqApiKey: session.groqApiKey,
            userName: session.userName || '',
        });
    } catch (err) {
        console.error('Validate error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
};

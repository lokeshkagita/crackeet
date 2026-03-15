const { getRedis, verifyAdmin } = require('../../lib/redis');

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    if (!verifyAdmin(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { code } = req.body || {};
    if (!code) {
        return res.status(400).json({ error: 'Session code is required' });
    }

    try {
        const redis = getRedis();
        const session = await redis.get(`session:${code.toUpperCase()}`);

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // Disable session
        await redis.set(`session:${code.toUpperCase()}`, {
            ...session,
            active: false,
            disabledAt: new Date().toISOString(),
        });

        return res.status(200).json({
            success: true,
            message: `Session ${code} disabled`,
        });
    } catch (err) {
        console.error('Disable session error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
};

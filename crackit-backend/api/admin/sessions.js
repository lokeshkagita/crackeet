const { getRedis, verifyAdmin } = require('../../lib/redis');

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    if (!verifyAdmin(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const redis = getRedis();
        const codes = await redis.smembers('sessions:all');

        if (!codes || codes.length === 0) {
            return res.status(200).json({ sessions: [] });
        }

        const sessions = [];
        for (const code of codes) {
            const session = await redis.get(`session:${code}`);
            if (session) {
                // Don't expose the actual API key in list view
                sessions.push({
                    code: session.code,
                    userName: session.userName,
                    active: session.active,
                    createdAt: session.createdAt,
                    usedAt: session.usedAt,
                    disabledAt: session.disabledAt,
                    keyPreview: session.groqApiKey ? `${session.groqApiKey.slice(0, 8)}...` : '',
                });
            }
        }

        // Sort by creation date (newest first)
        sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        return res.status(200).json({ sessions });
    } catch (err) {
        console.error('List sessions error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
};

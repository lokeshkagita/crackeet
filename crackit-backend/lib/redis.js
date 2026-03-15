const { Redis } = require('@upstash/redis');

let redis;

function getRedis() {
    if (!redis) {
        redis = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
    }
    return redis;
}

function generateSessionCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = 'CRACK-';
    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function verifyAdmin(req) {
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = auth.replace('Bearer ', '');
    return token === process.env.ADMIN_PASSWORD;
}

module.exports = { getRedis, generateSessionCode, verifyAdmin };

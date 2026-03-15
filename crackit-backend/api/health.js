module.exports = async function handler(req, res) {
    const hasRedisUrl = !!process.env.UPSTASH_REDIS_REST_URL;
    const hasRedisToken = !!process.env.UPSTASH_REDIS_REST_TOKEN;
    const hasAdminPassword = !!process.env.ADMIN_PASSWORD;

    const redisUrlPreview = process.env.UPSTASH_REDIS_REST_URL
        ? process.env.UPSTASH_REDIS_REST_URL.substring(0, 20) + '...'
        : 'NOT SET';

    return res.status(200).json({
        status: 'ok',
        env: {
            UPSTASH_REDIS_REST_URL: hasRedisUrl ? redisUrlPreview : 'NOT SET',
            UPSTASH_REDIS_REST_TOKEN: hasRedisToken ? 'SET' : 'NOT SET',
            ADMIN_PASSWORD: hasAdminPassword ? 'SET' : 'NOT SET',
        }
    });
};

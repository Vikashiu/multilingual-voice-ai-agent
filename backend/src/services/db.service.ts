import Redis from 'ioredis';
import { db } from '../db';
import { chatArchives } from '../db/schema';
import { config } from '../config/env';

export const redis = new Redis(config.REDIS_URL || 'redis://localhost:6379');

export class DataService {
    // --- REDIS: Chat message history ---

    static async saveToCache(sessionId: string, role: string, text: string) {
        const key = `chat:${sessionId}`;
        await redis.rpush(key, JSON.stringify({ role, text, time: new Date() }));
        await redis.expire(key, 3600);
    }

    static async getChatHistory(sessionId: string) {
        const messages = await redis.lrange(`chat:${sessionId}`, 0, -1);
        return messages.map(m => JSON.parse(m));
    }

    // --- REDIS: Session metadata (patient identity, language, etc.) ---

    static async setSessionMeta(sessionId: string, data: Record<string, string>) {
        const key = `session:${sessionId}`;
        await redis.hmset(key, data);
        await redis.expire(key, 3600);
    }

    static async getSessionMeta(sessionId: string): Promise<Record<string, string> | null> {
        const key = `session:${sessionId}`;
        const data = await redis.hgetall(key);
        return Object.keys(data).length > 0 ? data : null;
    }

    // --- POSTGRES: Archive session when call ends ---

    static async archiveSession(sessionId: string) {
        const history = await redis.lrange(`chat:${sessionId}`, 0, -1);
        if (history.length > 0) {
            const parsedHistory = history.map(m => JSON.parse(m));

            await db.insert(chatArchives)
                .values({ sessionId, transcript: parsedHistory })
                .onConflictDoUpdate({
                    target: chatArchives.sessionId,
                    set: { transcript: parsedHistory }
                });

            await redis.del(`chat:${sessionId}`);
            await redis.del(`session:${sessionId}`);
        }
    }
}

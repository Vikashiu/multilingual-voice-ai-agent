import Redis from 'ioredis';
import { db } from '../db';
import { chatArchives } from '../db/schema';
import { config } from '../config/env';
import { SessionMemory } from '../types/session';

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

    // --- REDIS: Structured session memory ---

    static async setSessionMemory(sessionId: string, memory: SessionMemory) {
        const key = `session-memory:${sessionId}`;
        await redis.set(key, JSON.stringify(memory), 'EX', 3600);
    }

    static async getSessionMemory(sessionId: string): Promise<SessionMemory | null> {
        const data = await redis.get(`session-memory:${sessionId}`);
        return data ? JSON.parse(data) : null;
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
        const memory = await DataService.getSessionMemory(sessionId);
        if (history.length > 0) {
            const parsedHistory = history.map(m => JSON.parse(m));

            await db.insert(chatArchives)
                .values({
                    sessionId,
                    transcript: {
                        messages: parsedHistory,
                        memory,
                    },
                })
                .onConflictDoUpdate({
                    target: chatArchives.sessionId,
                    set: {
                        transcript: {
                            messages: parsedHistory,
                            memory,
                        },
                    }
                });
        }

        await redis.del(`chat:${sessionId}`);
        await redis.del(`session:${sessionId}`);
        await redis.del(`session-memory:${sessionId}`);
    }
}

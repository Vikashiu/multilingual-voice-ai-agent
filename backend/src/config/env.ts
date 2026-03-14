import dotenv from 'dotenv';
dotenv.config();

export const config = {
    PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY || '',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    GROQ_API_KEY: process.env.GROQ_API_KEY || '',
    GROQ_MODEL: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    
    DATABASE_URL: process.env.DATABASE_URL || '',
    REDIS_URL: process.env.REDIS_URL || '',

    CARTESIA_API_KEY: process.env.CARTESIA_API_KEY || '',

    VOICES: {
        en: process.env.CARTESIA_VOICE_EN as string,
        hi: process.env.CARTESIA_VOICE_HI as string,
        ta: process.env.CARTESIA_VOICE_TA as string,
    }
};

import mongoose from 'mongoose';

// MongoDB is a CACHE here, never a source of truth. Everything in it can be
// rebuilt from chain logs with `npm run index`. So a missing database must not
// stop the API from serving — and it must not make startup hang either.
//
// The short server-selection timeout matters: with the driver's 30s default, a
// developer with no local MongoDB waits half a minute before the server binds
// its port, which looks like a crash.
const SELECTION_TIMEOUT_MS = 3000;

export async function connectDB() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('[Database] No DATABASE_URL set. Running without the cache — the chain is authoritative.');
    return null;
  }

  try {
    const conn = await mongoose.connect(dbUrl, {
      serverSelectionTimeoutMS: SELECTION_TIMEOUT_MS,
    });
    console.log('[Database] Connected to MongoDB:', conn.connection.host);
    return conn;
  } catch (error) {
    console.warn(
      `[Database] MongoDB unreachable (${error.message.split('\n')[0]}).\n` +
        '           Continuing without the cache. The chain still answers every read,\n' +
        '           and record metadata is rebuilt from logs on demand.'
    );
    return null;
  }
}

export const isDbReady = () => mongoose.connection.readyState === 1;

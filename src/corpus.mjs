// Location of the benchmark corpus (the hermes-corpus checkout). Override with HBC_CORPUS.
import path from 'node:path';
const HERE = path.dirname(new URL(import.meta.url).pathname);
export const CORPUS = process.env.HBC_CORPUS ?? path.resolve(HERE, '../../hermes-corpus');

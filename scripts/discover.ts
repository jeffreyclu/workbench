import 'dotenv/config';
import { openDatabase } from '../src/server/database.js';
import { runDiscovery, shouldRunDiscoveryCatchUp } from '../src/server/discovery.js';
import { WorkItemRepository } from '../src/server/repository.js';

const database = openDatabase();
const repository = new WorkItemRepository(database);
const lastRun = repository.getDiscoveryInbox().lastRun?.completedAt ?? null;
if (process.argv.includes('--force') || shouldRunDiscoveryCatchUp(lastRun)) await runDiscovery(repository);
database.close();

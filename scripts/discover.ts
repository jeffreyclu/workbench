import 'dotenv/config';
import { openDatabase } from '../src/server/database.js';
import { runDiscovery } from '../src/server/discovery.js';
import { WorkItemRepository } from '../src/server/repository.js';

const database = openDatabase();
const repository = new WorkItemRepository(database);
await runDiscovery(repository);
database.close();

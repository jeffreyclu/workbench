import 'dotenv/config';
import { createApp } from './app.js';
import { openDatabase } from './database.js';

const port = Number(process.env.PORT ?? 4317);
const database = openDatabase();
const app = createApp(database);

app.listen(port, () => {
  console.log(`Workbench API listening on http://localhost:${port}`);
});

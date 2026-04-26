import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from './schema.ts'

export type Db = ReturnType<typeof drizzle<typeof schema>>

export interface DbHandles {
	db: Db
	sqlite: Database.Database
	close(): void
}

export function openDb(dataDir: string): DbHandles {
	mkdirSync(dataDir, { recursive: true })
	const dbPath = join(dataDir, 'household.sqlite')
	const sqlite = new Database(dbPath)
	sqlite.pragma('journal_mode = WAL')
	sqlite.pragma('foreign_keys = ON')

	const db = drizzle(sqlite, { schema })

	const __dirname = dirname(fileURLToPath(import.meta.url))
	const migrationsFolder = join(__dirname, 'migrations')
	migrate(db, { migrationsFolder })

	return {
		db,
		sqlite,
		close: () => sqlite.close(),
	}
}

export { schema }

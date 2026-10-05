import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const HISTORY_SCHEMA_VERSION = 5;

/** One schema version owns the row, FTS and cursor publication contracts together. */
export function createHistorySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES ('generation','${randomUUID()}'),('version','0'),('indexedAt','0');
    CREATE TABLE runs(id TEXT PRIMARY KEY,attention INTEGER NOT NULL,updated INTEGER NOT NULL,negative_updated INTEGER NOT NULL,state TEXT NOT NULL,filter_text TEXT NOT NULL,view TEXT NOT NULL,predecessor_id TEXT,predecessor_index INTEGER);
    CREATE INDEX runs_predecessor ON runs(predecessor_id,predecessor_index);
    CREATE INDEX runs_attention ON runs(attention,negative_updated,id);
    CREATE INDEX runs_newest ON runs(negative_updated,id);
    CREATE INDEX runs_oldest ON runs(updated,id);
    CREATE INDEX runs_state ON runs(state,attention,negative_updated,id);
    CREATE TABLE sources(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,generation INTEGER NOT NULL DEFAULT 1,identity TEXT,stamp TEXT,session_id TEXT,header_digest TEXT,cursor INTEGER NOT NULL DEFAULT 0,prefix_digest TEXT,state TEXT NOT NULL DEFAULT 'pending',error TEXT,malformed INTEGER NOT NULL DEFAULT 0,complexity INTEGER NOT NULL DEFAULT 0,checked_at INTEGER,format_version INTEGER);
    CREATE TABLE children(run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,child_index INTEGER NOT NULL,agent TEXT NOT NULL,source_id TEXT REFERENCES sources(id),filter_text TEXT NOT NULL,output_digest TEXT,terminal_entry_id TEXT,ended_at INTEGER,PRIMARY KEY(run_id,child_index));
    CREATE INDEX children_source ON children(source_id);
    CREATE INDEX children_agent ON children(agent,run_id);
    CREATE TABLE entries(rowid INTEGER PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),generation INTEGER NOT NULL,id TEXT NOT NULL,native_id TEXT,parent_id TEXT,start INTEGER NOT NULL,end INTEGER NOT NULL,digest TEXT NOT NULL,timestamp INTEGER,type TEXT NOT NULL,preview TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0,role TEXT,assistant_text INTEGER NOT NULL DEFAULT 0,visible_id TEXT,human_id TEXT,configuration_model TEXT,configuration_thinking TEXT,UNIQUE(source_id,generation,id),UNIQUE(source_id,generation,start));
    CREATE INDEX entries_page ON entries(source_id,generation,published,start);
    CREATE INDEX entries_time ON entries(source_id,generation,published,timestamp,start);
    CREATE INDEX entries_human ON entries(source_id,generation,human_id,start);
    CREATE TABLE answers(entry_rowid INTEGER NOT NULL REFERENCES entries(rowid) ON DELETE CASCADE,digest TEXT NOT NULL,item_id TEXT NOT NULL,PRIMARY KEY(entry_rowid,digest));
    CREATE INDEX answers_digest ON answers(digest,entry_rowid);
    CREATE TABLE tools(entry_rowid INTEGER NOT NULL REFERENCES entries(rowid) ON DELETE CASCADE,source_id TEXT NOT NULL,generation INTEGER NOT NULL,call_id TEXT NOT NULL,kind TEXT NOT NULL);
    CREATE INDEX tools_lookup ON tools(source_id,generation,call_id,kind);
    CREATE TABLE documents(id INTEGER PRIMARY KEY,entry_rowid INTEGER NOT NULL REFERENCES entries(rowid) ON DELETE CASCADE,field TEXT NOT NULL,text_start INTEGER NOT NULL,text_end INTEGER NOT NULL,preview TEXT NOT NULL);
    CREATE INDEX documents_entry ON documents(entry_rowid);
    CREATE VIRTUAL TABLE corpus USING fts5(text,content='',contentless_delete=1,tokenize='unicode61');
    PRAGMA user_version=${HISTORY_SCHEMA_VERSION};
  `);
}

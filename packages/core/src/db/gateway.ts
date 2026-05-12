import {
  createChunkRepository,
} from "../repositories/chunk.repository";
import { createEvalRepository } from "../repositories/eval.repository";
import { createMessageRepository } from "../repositories/message.repository";
import type { Db } from "./client";

// S2 임시 facade — 외부 호출 사이트를 한 번에 안 깨려고 기존 gateway 모양만 유지한다.
// S4에서 core composition root가 repository를 직접 service에 주입하도록 바뀌면 본 파일은 제거.

export type {
  SearchFilter,
  SearchOptions,
  SearchResult,
} from "../repositories/chunk.repository";
export type { EvalItem, EvalRunRow, SaveRunArgs } from "../repositories/eval.repository";
export type { SavePairArgs } from "../repositories/message.repository";

export type Gateway = ReturnType<typeof createGateway>;

export function createGateway(db: Db) {
  const chunkRepo = createChunkRepository(db);
  const messageRepo = createMessageRepository(db);
  const evalRepo = createEvalRepository(db);
  return {
    chunks: chunkRepo,
    messages: messageRepo,
    evalItems: { upsert: evalRepo.upsertItems },
    eval: { saveRun: evalRepo.saveRun, listRuns: evalRepo.listRuns },
  };
}

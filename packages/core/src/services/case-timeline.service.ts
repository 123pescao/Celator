import type { CaseTimelineRepository } from '@celator/db';
import type { CaseTimelineEvent, ActorType, TaskStatus } from '@celator/db';

export interface TimelineEventInput {
  caseId: string;
  taskId?: string;
  eventType: string;
  fromStatus?: TaskStatus;
  toStatus?: TaskStatus;
  actorId?: string;
  actorType: ActorType;
  note?: string;
}

export class CaseTimelineService {
  constructor(private readonly repo: CaseTimelineRepository) {}

  async append(input: TimelineEventInput): Promise<CaseTimelineEvent> {
    return this.repo.create({
      case: { connect: { id: input.caseId } },
      eventType: input.eventType,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      actorId: input.actorId ?? null,
      actorType: input.actorType,
      note: input.note ?? null,
      ...(input.taskId ? { task: { connect: { id: input.taskId } } } : {}),
    });
  }

  async listForCase(caseId: string): Promise<CaseTimelineEvent[]> {
    return this.repo.listForCase(caseId);
  }

  async listForTask(taskId: string): Promise<CaseTimelineEvent[]> {
    return this.repo.listForTask(taskId);
  }
}

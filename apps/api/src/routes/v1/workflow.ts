import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

// ─── Shared schemas ───────────────────────────────────────────────────────────

const SourceTypeSchema = z.enum([
  'DATA_BROKER', 'SEARCH_ENGINE', 'SOCIAL_PLATFORM', 'PUBLIC_RECORD_SITE',
  'PEOPLE_SEARCH', 'BREACH_INDEX', 'OTHER',
]);

const WorkflowStepKindSchema = z.enum([
  'VERIFY_TARGET_REQUIREMENTS', 'PREPARE_REMOVAL_DRAFT', 'OPERATOR_REVIEW',
  'MANUAL_SUBMISSION', 'WAIT_FOR_CONFIRMATION', 'RECORD_OUTCOME',
  'VERIFY_REMOVAL', 'CLOSE_TASK', 'CUSTOM',
]);

const PlaybookStepBody = z.object({
  stepOrder: z.number().int().positive(),
  stepKind: WorkflowStepKindSchema,
  title: z.string().min(1).max(500),
  instructions: z.string().min(1).max(5000),
  requiresApproval: z.boolean().optional(),
  requiresManualSubmission: z.boolean().optional(),
  requiredEvidenceType: z.string().max(100).optional(),
});

const CreatePlaybookBody = z.object({
  name: z.string().min(1).max(500),
  version: z.string().min(1).max(50),
  sourceType: SourceTypeSchema.optional(),
  dataSourceTargetId: z.string().optional(),
  description: z.string().max(2000).optional(),
  steps: z.array(PlaybookStepBody).min(1),
});

const StartWorkflowBody = z.object({
  clientId: z.string().min(1),
  playbookId: z.string().optional(),
});

const AdvanceStepBody = z.object({
  clientId: z.string().min(1),
  operatorNotes: z.string().max(2000).optional(),
  safeResultSummary: z.string().max(2000).optional(),
});

const BlockStepBody = z.object({
  clientId: z.string().min(1),
  reason: z.string().min(1).max(2000),
});

const AttachManualSubmissionBody = z.object({
  clientId: z.string().min(1),
  manualSubmissionId: z.string().min(1),
});

const UnblockStepBody = z.object({
  clientId: z.string().min(1),
  operatorNotes: z.string().max(2000).optional(),
});

const CancelWorkflowBody = z.object({
  clientId: z.string().min(1),
  reason: z.string().min(1).max(2000),
});

const PatchPlaybookStatusBody = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE', 'DEPRECATED']),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

export const workflowRoutes: FastifyPluginAsync<{
  services: AppServices;
  userRepo: UserRepository;
}> = async (fastify, opts) => {
  const { workflowEngineService } = opts.services;
  const { userRepo } = opts;

  // POST /removal-playbooks — create a playbook with steps
  fastify.post('/removal-playbooks', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = CreatePlaybookBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { sourceType, dataSourceTargetId, description, ...base } = body.data;
    const result = await workflowEngineService.createPlaybook(
      {
        ...base,
        ...(sourceType !== undefined ? { sourceType } : {}),
        ...(dataSourceTargetId !== undefined ? { dataSourceTargetId } : {}),
        ...(description !== undefined ? { description } : {}),
      },
      ctx.actor.id,
    );
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.code(201).send({ ok: true, playbook: result.value });
  });

  // GET /removal-playbooks — list active playbooks
  fastify.get('/removal-playbooks', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const playbooks = await workflowEngineService.listPlaybooks();
    return reply.send({ ok: true, playbooks });
  });

  // GET /removal-playbooks/:playbookId — get playbook with steps
  fastify.get('/removal-playbooks/:playbookId', async (request, reply) => {
    const { playbookId } = request.params as { playbookId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await workflowEngineService.getPlaybook(playbookId);
    if (!result.ok) return reply.code(404).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, playbook: result.value });
  });

  // POST /tasks/:taskId/workflow-runs — start a workflow for a task
  fastify.post('/tasks/:taskId/workflow-runs', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = StartWorkflowBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, playbookId } = body.data;
    const result = await workflowEngineService.startWorkflowForTask(
      {
        taskId,
        clientId,
        ...(playbookId !== undefined ? { playbookId } : {}),
      },
      ctx.actor.id,
    );
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.code(201).send({ ok: true, workflowState: result.value });
  });

  // GET /tasks/:taskId/workflow-run — get workflow state for a task
  fastify.get('/tasks/:taskId/workflow-run', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await workflowEngineService.getWorkflowStateByTaskId(taskId);
    if (!result.ok) return reply.code(404).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, workflowState: result.value });
  });

  // POST /workflow-runs/:workflowRunId/steps/:stepRunId/advance — advance a step
  fastify.post('/workflow-runs/:workflowRunId/steps/:stepRunId/advance', async (request, reply) => {
    const { workflowRunId, stepRunId } = request.params as { workflowRunId: string; stepRunId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = AdvanceStepBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, operatorNotes, safeResultSummary } = body.data;
    const result = await workflowEngineService.advanceStep(
      workflowRunId,
      stepRunId,
      {
        ...(operatorNotes !== undefined ? { operatorNotes } : {}),
        ...(safeResultSummary !== undefined ? { safeResultSummary } : {}),
      },
      clientId,
      ctx.actor.id,
    );
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, workflowState: result.value });
  });

  // POST /workflow-runs/:workflowRunId/steps/:stepRunId/block — block a step
  fastify.post('/workflow-runs/:workflowRunId/steps/:stepRunId/block', async (request, reply) => {
    const { workflowRunId, stepRunId } = request.params as { workflowRunId: string; stepRunId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = BlockStepBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, reason } = body.data;
    const result = await workflowEngineService.blockStep(
      workflowRunId,
      stepRunId,
      { reason },
      clientId,
      ctx.actor.id,
    );
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, workflowState: result.value });
  });

  // POST /workflow-runs/:workflowRunId/steps/:stepRunId/manual-submission — link submission
  fastify.post('/workflow-runs/:workflowRunId/steps/:stepRunId/manual-submission', async (request, reply) => {
    const { workflowRunId, stepRunId } = request.params as { workflowRunId: string; stepRunId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = AttachManualSubmissionBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, manualSubmissionId } = body.data;
    const result = await workflowEngineService.attachManualSubmission(
      workflowRunId,
      stepRunId,
      { manualSubmissionId },
      clientId,
      ctx.actor.id,
    );
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, workflowState: result.value });
  });

  // POST /workflow-runs/:workflowRunId/steps/:stepRunId/unblock — unblock a blocked step
  fastify.post('/workflow-runs/:workflowRunId/steps/:stepRunId/unblock', async (request, reply) => {
    const { workflowRunId, stepRunId } = request.params as { workflowRunId: string; stepRunId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = UnblockStepBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, operatorNotes } = body.data;
    const result = await workflowEngineService.unblockStep(
      workflowRunId,
      stepRunId,
      { ...(operatorNotes !== undefined ? { operatorNotes } : {}) },
      clientId,
      ctx.actor.id,
    );
    if (!result.ok) {
      const code = result.error === 'WORKFLOW_RUN_NOT_FOUND' || result.error === 'WORKFLOW_STEP_NOT_FOUND' ? 404 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, workflowState: result.value });
  });

  // POST /workflow-runs/:workflowRunId/cancel — cancel a workflow run
  fastify.post('/workflow-runs/:workflowRunId/cancel', async (request, reply) => {
    const { workflowRunId } = request.params as { workflowRunId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = CancelWorkflowBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, reason } = body.data;
    const result = await workflowEngineService.cancelWorkflow(
      workflowRunId,
      { reason },
      clientId,
      ctx.actor.id,
    );
    if (!result.ok) {
      const code = result.error === 'WORKFLOW_RUN_NOT_FOUND' ? 404 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, workflowState: result.value });
  });

  // PATCH /removal-playbooks/:playbookId/status — change playbook status
  fastify.patch('/removal-playbooks/:playbookId/status', async (request, reply) => {
    const { playbookId } = request.params as { playbookId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = PatchPlaybookStatusBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await workflowEngineService.setPlaybookStatus(playbookId, body.data.status, ctx.actor.id);
    if (!result.ok) {
      const code = result.error === 'PLAYBOOK_NOT_FOUND' ? 404 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, playbook: result.value });
  });

  // GET /clients/:clientId/workflow-runs — list workflow run headers for a client
  fastify.get('/clients/:clientId/workflow-runs', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const runs = await workflowEngineService.listWorkflowRunsForClient(clientId);
    return reply.send({ ok: true, runs });
  });
};

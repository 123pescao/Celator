-- Phase 1E: Data Source Target Registry + Removal Request Builder

-- Link CleanupTask to DataSourceTarget (nullable, backward-compatible)
ALTER TABLE "cleanup_tasks"
  ADD COLUMN "dataSourceTargetId" TEXT REFERENCES "data_source_targets"("id") ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX "cleanup_tasks_dataSourceTargetId_idx"
  ON "cleanup_tasks"("dataSourceTargetId");

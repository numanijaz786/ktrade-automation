-- DropIndex
DROP INDEX "recommendation_outcomes_recommendationId_lastBarDate_key";

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_outcomes_recommendationId_lastBarDate_status_key" ON "recommendation_outcomes"("recommendationId", "lastBarDate", "status");


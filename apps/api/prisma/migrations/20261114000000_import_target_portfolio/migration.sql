-- AlterTable
ALTER TABLE "imported_statements" ADD COLUMN     "portfolioId" UUID;

-- AddForeignKey
ALTER TABLE "imported_statements" ADD CONSTRAINT "imported_statements_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


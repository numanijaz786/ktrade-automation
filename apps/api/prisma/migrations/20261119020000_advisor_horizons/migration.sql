-- Six-horizon advisor engine: add the engine's horizons next to the original three (additive; no data change).
ALTER TYPE "RecommendationHorizon" ADD VALUE IF NOT EXISTS 'SWING';
ALTER TYPE "RecommendationHorizon" ADD VALUE IF NOT EXISTS 'DIVIDEND';
ALTER TYPE "RecommendationHorizon" ADD VALUE IF NOT EXISTS 'VALUE';
ALTER TYPE "RecommendationHorizon" ADD VALUE IF NOT EXISTS 'GROWTH';

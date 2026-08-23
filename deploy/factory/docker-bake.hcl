variable "AI_SOURCE_REVISION" { default = "unknown" }
variable "AI_SOURCE_DIGEST" { default = "unknown" }
variable "AI_BUILD_DATE" { default = "unknown" }
variable "AI_VERSION" { default = "0.6.2" }

group "factory" {
  targets = ["inference-api", "inference-manager", "inference-vllm", "inference-evaluator", "inference-migrations", "training-api", "training-manager", "axolotl-worker", "marker-worker", "artifact-worker", "training-migrations"]
}

target "defaults" {
  context = "."
  platforms = ["linux/amd64"]
  labels = {
    "org.opencontainers.image.version" = AI_VERSION
    "org.opencontainers.image.revision" = AI_SOURCE_REVISION
    "org.opencontainers.image.created" = AI_BUILD_DATE
    "org.treeseed-ai.source.digest" = AI_SOURCE_DIGEST
  }
}

target "inference-api" {
  inherits = ["defaults"]
  dockerfile = "containers/inference/api.Dockerfile"
  tags = ["local/inference-api:${AI_VERSION}"]
  labels = { "org.treeseed-ai.role" = "inference-api" }
}
target "inference-manager" {
  inherits = ["defaults"]
  dockerfile = "containers/inference/manager.Dockerfile"
  tags = ["local/inference-manager:${AI_VERSION}"]
  labels = { "org.treeseed-ai.role" = "inference-manager" }
}
target "inference-vllm" {
  inherits = ["defaults"]
  dockerfile = "containers/inference/vllm.Dockerfile"
  tags = ["local/inference-vllm:${AI_VERSION}"]
  labels = { "org.treeseed-ai.role" = "inference-vllm" }
}
target "inference-evaluator" {
  inherits = ["defaults"]
  dockerfile = "containers/inference/evaluator.Dockerfile"
  tags = ["local/inference-evaluator:${AI_VERSION}"]
  labels = { "org.treeseed-ai.role" = "inference-evaluator" }
}
target "inference-migrations" {
  inherits = ["defaults"]
  dockerfile = "containers/inference/migrations.Dockerfile"
  tags = ["local/inference-migrations:${AI_VERSION}"]
  labels = { "org.treeseed-ai.role" = "inference-migrations" }
}
target "training-api" {
  inherits = ["defaults"]
  dockerfile = "containers/training/api.Dockerfile"
  tags = ["local/training-api:${AI_VERSION}"]
  labels = { "org.treeseed-ai.role" = "training-api" }
}
target "training-manager" {
  inherits = ["defaults"]
  dockerfile = "containers/training/manager.Dockerfile"
  tags = ["local/training-manager:${AI_VERSION}"]
  labels = { "org.treeseed-ai.role" = "training-manager" }
}
target "axolotl-worker" {
  inherits = ["defaults"]
  dockerfile = "containers/training/axolotl.Dockerfile"
  tags = ["local/axolotl-worker:${AI_VERSION}"]
  labels = { "org.treeseed-ai.role" = "axolotl-worker" }
}
target "marker-worker" {
  inherits = ["defaults"]
  dockerfile = "containers/training/marker.Dockerfile"
  tags = ["local/marker-worker:${AI_VERSION}"]
  labels = { "org.treeseed-ai.role" = "marker-worker" }
}
target "artifact-worker" {
  inherits = ["defaults"]
  dockerfile = "containers/training/artifact.Dockerfile"
  tags = ["local/artifact-worker:${AI_VERSION}"]
  labels = { "org.treeseed-ai.role" = "artifact-worker" }
}
target "training-migrations" {
  inherits = ["defaults"]
  dockerfile = "containers/training/migrations.Dockerfile"
  tags = ["local/training-migrations:${AI_VERSION}"]
  labels = { "org.treeseed-ai.role" = "training-migrations" }
}

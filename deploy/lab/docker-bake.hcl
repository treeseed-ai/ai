variable "AI_SOURCE_REVISION" { default = "unknown" }
variable "AI_SOURCE_DIGEST" { default = "unknown" }
variable "AI_BUILD_DATE" { default = "unknown" }
variable "AI_VERSION" { default = "0.7.0" }

group "default" {
  targets = ["lab-controller", "lab-experience-proxy", "hermes-agent"]
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

target "lab-controller" {
  inherits = ["defaults"]
  dockerfile = "containers/lab/service.Dockerfile"
  args = { LAB_ENTRY = "controller" }
  tags = ["local/lab-controller:${AI_VERSION}"]
  labels = { "org.treeseed-ai.role" = "lab-controller" }
}

target "lab-experience-proxy" {
  inherits = ["defaults"]
  dockerfile = "containers/lab/service.Dockerfile"
  args = { LAB_ENTRY = "proxy" }
  tags = ["local/lab-experience-proxy:${AI_VERSION}"]
  labels = { "org.treeseed-ai.role" = "lab-experience-proxy" }
}

target "hermes-agent" {
  inherits = ["defaults"]
  dockerfile = "containers/lab/hermes.Dockerfile"
  tags = ["local/hermes-agent:${AI_VERSION}"]
  labels = { "org.treeseed-ai.role" = "hermes-agent" }
}

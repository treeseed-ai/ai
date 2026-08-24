import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProfiles, extractProfileMarker, profileMarker } from "../../../packages/lab/src/agents/index.js";

function store(){return new AgentProfiles(mkdtempSync(join(tmpdir(),"treeai-agents-")));}
describe("adapter-backed Hermes agents",()=>{
	it("creates drafts and exposes promoted profiles",()=>{const profiles=store(),draft=profiles.draft({libraryId:"library-1",librarySlug:"finance",candidateId:"candidate-1"});expect(draft.status).toBe("draft");expect(()=>profiles.status(draft.id,"enabled")).toThrow(/evaluation/u);const active=profiles.promote("library-1","finance","candidate-1",["evaluation-1"]);expect(active.status).toBe("enabled");expect(active.modelAlias).toBe("library/finance");});
	it("pins automatic routing until an explicit segment handoff",()=>{const profiles=store(),finance=profiles.promote("l1","finance","c1",["e1"]),network=profiles.promote("l2","networking","c2",["e2"]),first=profiles.select("agent/auto",[{role:"user",content:"analyze finance statements"}],"chat-1")!,pinned=profiles.select("agent/auto",[{role:"user",content:"now discuss networking"}],"chat-1")!;expect(first.profile.id).toBe(finance.id);expect(pinned.profile.id).toBe(finance.id);const handoff=profiles.handoff("chat-1",network.id,{goal:"network analysis"}),next=profiles.select("agent/auto",[],"chat-1")!;expect(next.profile.id).toBe(network.id);expect(next.decision.segmentId).toBe(handoff.segmentId);expect(handoff.priorSegmentId).toBe(first.decision.segmentId);});
	it("round trips internal routing markers",()=>{const profiles=store(),profile=profiles.promote("l1","vision","c1",["e1"]),segment=crypto.randomUUID(),marker=profileMarker(profile,segment),parsed=extractProfileMarker([{role:"system",content:`${marker}\nUse grounded evidence.`}]);expect(parsed).toMatchObject({profileId:profile.id,segmentId:segment,modelAlias:"library/vision",clean:"Use grounded evidence."});});
	it("rejects arbitrary aliases and tools",()=>{const profiles=store();expect(()=>profiles.upsert({slug:"unsafe",displayName:"Unsafe",modelAlias:"http://raw-vllm"})).toThrow(/allowlisted/u);expect(()=>profiles.upsert({slug:"unsafe",displayName:"Unsafe",modelAlias:"local-model",allowedTools:["docker"]})).toThrow(/unsupported/u);});
});

export const VERSION='0.5.0';
export const descriptorRoot=process.env.TREEAI_DESCRIPTOR_ROOT??'/usr/lib/treeseed-ai/commands.d';
export const configPath=process.env.TREEAI_CONFIG??'/etc/treeseed-ai/treeai/config.json';
export const keyPath=process.env.TREEAI_OPERATOR_KEY??'/etc/treeseed-ai/treeai/operator.key';
export const packageNames={host:'treeseed-ai-host-runtime',factory:'treeseed-ai-host-runtime',inference:'treeseed-ai-inference',training:'treeseed-ai-training',lab:'treeseed-ai-lab'}as const;
export const executables={host:'/usr/lib/treeseed-ai/host-runtime/dist/cli.js',factory:'/usr/lib/treeseed-ai/host-runtime/dist/factory/dev-cli.js',inference:'/usr/lib/treeseed-ai/cli/dist/product-cli.js',training:'/usr/lib/treeseed-ai/cli/dist/product-cli.js',lab:'/usr/lib/treeseed-ai/lab/dist/cli.js'}as const;
export type Group=keyof typeof packageNames;
export interface Descriptor{schemaVersion:'treeai.command-descriptor/v1';group:Group;package:string;version:string;executable:string;commands:string[]}
export interface ClientConfig{schemaVersion:'treeai.config/v1';version:string;deploymentMode:'development'|'published';ca:string;endpoints:Record<string,string>;installedProducts:string[]}
export function envelope(code:string,message:string,details?:unknown){return{error:{code,message,...(details===undefined?{}:{details})}};}

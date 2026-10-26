// #4364: the TypeScript surface of `check-allow-builds.mjs`, which stays
// JavaScript because the `verify` job runs it with a bare `node` before the
// install. `src/lib/__tests__/deployment-image-contracts.test.ts` imports
// `readAllowBuilds` from it; keep this in step with the `export` statements in
// the `.mjs`.
export type AllowBuildsEntry = {
  name: string;
  versions: string[];
  allowed: boolean;
};
export declare const WORKSPACE_FILE: string;
export declare const LOCKFILE: string;
export declare const DEPENDABOT_FILE: string;
export declare const INSTALL_SCRIPTS_GROUP: string;
export declare const REAPPROVAL_GUIDE: string;
export declare function readAllowBuilds(workspaceText: string): AllowBuildsEntry[];
export declare function lockfileVersions(lockText: string): Map<string, Set<string>>;
export declare function allowBuildsProblems(input: {
  workspaceText: string;
  lockText: string;
}): string[];
export declare function dependabotGroupProblems(input: {
  dependabotText: string;
  workspaceText: string;
}): string[];
export declare function checkWorkingTree(root: string): {
  allowBuilds: string[];
  dependabot: string[];
  approvals: number;
};

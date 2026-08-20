import { getPinnedRevision, type PinnedSkill } from "./repo";

export type SkillPinIntegrityCode =
  | "invalid_skill_pin"
  | "missing_skill_revision"
  | "missing_skill_content_hash"
  | "skill_content_hash_mismatch";

export class SkillPinIntegrityError extends Error {
  readonly code: SkillPinIntegrityCode;

  constructor(code: SkillPinIntegrityCode, message: string) {
    super(message);
    this.name = "SkillPinIntegrityError";
    this.code = code;
  }
}

export interface SkillPinReference {
  readonly skillId: string | null;
  readonly skillVersion: number | null;
  readonly skillContentHash: string | null;
}

function hasAnyPinField(pin: SkillPinReference): boolean {
  return pin.skillId !== null || pin.skillVersion !== null || pin.skillContentHash !== null;
}

export async function resolveExecutableSkillPin(
  pin: SkillPinReference,
  options: { readonly requireContentHash?: boolean } = {},
): Promise<PinnedSkill | null> {
  if (!hasAnyPinField(pin)) return null;
  if (!pin.skillId || pin.skillVersion === null) {
    throw new SkillPinIntegrityError(
      "invalid_skill_pin",
      "pinned skill revision is incomplete",
    );
  }
  if (options.requireContentHash && !pin.skillContentHash) {
    throw new SkillPinIntegrityError(
      "missing_skill_content_hash",
      "pinned skill revision is missing its content hash",
    );
  }

  const revision = await getPinnedRevision(pin.skillId, pin.skillVersion);
  if (!revision) {
    throw new SkillPinIntegrityError(
      "missing_skill_revision",
      "pinned skill revision is missing",
    );
  }
  if (pin.skillContentHash && revision.contentHash !== pin.skillContentHash) {
    throw new SkillPinIntegrityError(
      "skill_content_hash_mismatch",
      "pinned skill revision hash mismatch",
    );
  }
  return revision;
}

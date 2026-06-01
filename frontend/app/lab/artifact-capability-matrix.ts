import {
  ARTIFACT_AUTHORING_PROFILES,
  artifactCapabilitiesFor,
  contentTypeForName,
} from "@useagent/artifact-workspace";

export const ARTIFACT_CAPABILITY_ROWS = ARTIFACT_AUTHORING_PROFILES.map((profile) => ({
  ...profile,
  ...artifactCapabilitiesFor({
    name: profile.defaultName,
    content_type: contentTypeForName(profile.defaultName),
    size_bytes: 0,
  }),
}));

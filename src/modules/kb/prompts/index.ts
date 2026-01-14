import { getResumesPrompt } from "./resumes";
import { getPastPerformancePrompt } from "./past_performance";
import { getCapabilitiesPrompt } from "./capabilities";
import { getCompliancePrompt } from "./compliance";
import { getTemplatesPrompt } from "./templates";
import { getOtherPrompt } from "./other";

export function getKbPrompt(
  kbType: string,
  preview: string,
  filename?: string,
  title?: string
) {
  const t = (kbType || "other").toLowerCase();
  switch (t) {
    case "resumes":
      return getResumesPrompt(preview, filename, title);
    case "past_performance":
      return getPastPerformancePrompt(preview, filename, title);
    case "capabilities":
      return getCapabilitiesPrompt(preview, filename, title);
    case "compliance":
    case "compliance_quality":
      return getCompliancePrompt(preview, filename, title);
    case "templates":
    case "templates_boilerplate":
      return getTemplatesPrompt(preview, filename, title);
    default:
      return getOtherPrompt(preview, filename, title);
  }
}

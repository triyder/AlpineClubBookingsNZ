// Canonical default Lodge Induction checklist (adapted from a club's 2008 lodge
// induction sheet). This is a pure data module so
// it can be shared by the Prisma seed (Node) and the app runtime without
// pulling in `server-only`. The seed creates this template create-if-missing;
// admins may then edit it (a new version is created once a template has been
// used, so historical induction wording is never mutated).

import type {
  InductionKind,
  InductionSectionPriority,
} from "@prisma/client";

const DEFAULT_INDUCTION_TEMPLATE_NAME = "Lodge Induction Checklist";
const DEFAULT_INDUCTION_TEMPLATE_VERSION = "2008.1";
const DEFAULT_INDUCTION_TEMPLATE_SOURCE_LABEL =
  "Lodge Induction Sheet (2008)";

// Final sponsor/inductor declaration shown above the sign-off action. Each
// sign-off records acceptance of this statement (declarationAccepted).
export const INDUCTION_SIGN_OFF_DECLARATION =
  "I confirm that I have explained and demonstrated, where necessary, each of " +
  "the above matters to the member and I am satisfied that they are " +
  "fully competent and familiar with the lodge system.";

interface InductionTemplateItemSeed {
  /** Stable slug used as a logical key in code and tests (not the DB id). */
  key: string;
  label: string;
  competencyPrompt?: string;
  notesPrompt?: string;
  isMandatory?: boolean;
  requiresDemonstration?: boolean;
  legacySourceText?: string;
}

interface InductionTemplateSectionSeed {
  priority: InductionSectionPriority;
  title: string;
  description?: string;
  items: InductionTemplateItemSeed[];
}

export interface InductionTemplateSeed {
  name: string;
  version: string;
  kind: InductionKind;
  sourceLabel: string;
  sections: InductionTemplateSectionSeed[];
}

export const DEFAULT_INDUCTION_TEMPLATE: InductionTemplateSeed = {
  name: DEFAULT_INDUCTION_TEMPLATE_NAME,
  version: DEFAULT_INDUCTION_TEMPLATE_VERSION,
  kind: "NEW_MEMBER",
  sourceLabel: DEFAULT_INDUCTION_TEMPLATE_SOURCE_LABEL,
  sections: [
    {
      priority: "EMERGENCY",
      title: "Emergency and safety",
      description:
        "Mandatory items. Cover these first with every inductee.",
      items: [
        {
          key: "emergency-evacuation-procedures",
          label: "Evacuation procedures",
          competencyPrompt: "Member understands what to do during an evacuation.",
          notesPrompt: "Include local evacuation steps.",
          isMandatory: true,
        },
        {
          key: "emergency-assembly-area",
          label: "Assembly area",
          competencyPrompt: "Member knows where to assemble after evacuation.",
          notesPrompt: "Store current assembly area.",
          isMandatory: true,
        },
        {
          key: "emergency-warm-clothes",
          label: "Importance of warm clothes",
          competencyPrompt:
            "Member understands the need for suitable warm clothing in alpine conditions.",
          notesPrompt: "Include practical clothing expectations.",
          isMandatory: true,
        },
        {
          key: "emergency-eruption-lahar",
          label: "Eruption procedures and predominant lahar paths",
          competencyPrompt:
            "Member understands volcanic eruption response and lahar path risk.",
          notesPrompt: "Include local mountain/lahar guidance.",
          isMandatory: true,
        },
        {
          key: "emergency-water-supply-disconnection",
          label: "Disconnection of water supply",
          competencyPrompt:
            "Member knows how and when to disconnect the water supply.",
          notesPrompt: "Include valve/switch location and sequence.",
          isMandatory: true,
          requiresDemonstration: true,
        },
        {
          key: "emergency-fire-extinguishers",
          label: "Location and operation of fire extinguishers",
          competencyPrompt:
            "Member knows where extinguishers are and how to use them.",
          notesPrompt: "Include extinguisher locations and type-specific notes.",
          isMandatory: true,
          requiresDemonstration: true,
        },
        {
          key: "emergency-first-aid-kit",
          label: "First aid kit",
          competencyPrompt: "Member knows where the first aid kit is kept.",
          notesPrompt: "Include location and restocking/reporting process.",
          isMandatory: true,
        },
        {
          key: "emergency-phone-numbers",
          label: "Emergency phone numbers",
          competencyPrompt:
            "Member knows where emergency contact numbers are located and when to use them.",
          notesPrompt:
            "Include emergency, committee, hut leader, and local contacts.",
          isMandatory: true,
        },
      ],
    },
    {
      priority: "SECURITY",
      title: "Security",
      items: [
        {
          key: "security-entrance-doors",
          label:
            "Ensure entrance doors are closed, especially the ski room door",
          competencyPrompt:
            "Member understands that external doors must be closed and secured.",
          notesPrompt: "Include any door-specific instructions.",
        },
        {
          key: "security-vacating-lodge",
          label:
            "When vacating the lodge, ensure all windows are closed, ranch sliders are bolted, and the main entrance door is shut",
          competencyPrompt:
            "Member understands the departure security check.",
          notesPrompt: "Include full lock-up sequence.",
        },
      ],
    },
    {
      priority: "STARTUP",
      title: "Starting the lodge up",
      items: [
        {
          key: "startup-power-supply-switch",
          label: "Power supply switch location",
          competencyPrompt:
            "Member knows where the power supply switch is and how it is used.",
          notesPrompt: "Include switch location and safe operating notes.",
          requiresDemonstration: true,
        },
        {
          key: "startup-water-pump-switch",
          label: "Water pump switch location",
          competencyPrompt:
            "Member knows where the water pump switch is and how it is used.",
          notesPrompt: "Include pump switch location and start-up sequence.",
          requiresDemonstration: true,
        },
        {
          key: "startup-water-isolation-valves",
          label: "Water isolation valves location",
          competencyPrompt: "Member knows where the water isolation valves are.",
          notesPrompt: "Include valve locations and valve state on arrival.",
          requiresDemonstration: true,
        },
        {
          key: "startup-follow-procedures",
          label: "Importance of following procedures accurately",
          competencyPrompt:
            "Member understands that lodge start-up procedures must be followed exactly.",
          notesPrompt:
            "Include warning text and consequences of incorrect sequence.",
        },
      ],
    },
    {
      priority: "SHUTDOWN",
      title: "Shutting the lodge down",
      items: [
        {
          key: "shutdown-water-sequence",
          label: "Sequence of watering / water shutdown procedure",
          competencyPrompt:
            "Member understands the required water shutdown or watering sequence.",
          notesPrompt:
            "Confirm exact current wording with the club before finalising.",
          requiresDemonstration: true,
          legacySourceText: 'The scanned source says "Sequence of watering".',
        },
        {
          key: "shutdown-valves-opened",
          label: "Importance of ensuring all valves are opened",
          competencyPrompt:
            "Member understands which valves must be opened before leaving.",
          notesPrompt: "Confirm current operational sequence with the club.",
          requiresDemonstration: true,
        },
        {
          key: "shutdown-pump-power-off",
          label: "Power supply switched off to pump",
          competencyPrompt:
            "Member knows to switch off power to the pump as part of shutdown.",
          notesPrompt: "Include pump switch location.",
          requiresDemonstration: true,
        },
        {
          key: "shutdown-main-switch-off",
          label: "Main switch turned to OFF",
          competencyPrompt:
            "Member knows when and how to turn the main switch to OFF.",
          notesPrompt: "Include main switch location and exceptions.",
          requiresDemonstration: true,
        },
        {
          key: "shutdown-empty-fridge",
          label: "Empty fridge",
          competencyPrompt:
            "Member knows the fridge must be emptied before departure.",
          notesPrompt: "Include food disposal and cleaning expectations.",
        },
      ],
    },
    {
      priority: "GENERAL",
      title: "General lodge rules and responsibilities",
      items: [
        {
          key: "general-hut-leader-authority",
          label: "Purpose and authority of hut leader",
          competencyPrompt:
            "Member understands the hut leader's role and authority.",
          notesPrompt: "Include escalation and dispute process.",
        },
        {
          key: "general-bedroom-no-food",
          label: "Bedroom areas: no food etc",
          competencyPrompt:
            "Member understands that food is not to be kept or eaten in bedroom areas.",
          notesPrompt: "Include pest and hygiene rationale.",
        },
        {
          key: "general-children-non-members",
          label: "Responsibility for your children and non-members",
          competencyPrompt:
            "Member understands they are responsible for their children and non-member guests.",
          notesPrompt: "Include guest supervision expectations.",
        },
        {
          key: "general-water-conservation",
          label: "Water conservation required as limited storage",
          competencyPrompt:
            "Member understands water must be conserved due to limited storage.",
          notesPrompt: "Include water-saving rules.",
        },
        {
          key: "general-food-storage-room",
          label: "Off-site food storage location",
          competencyPrompt: "Member knows where food should be stored.",
          notesPrompt: "Include the exact off-site food storage location.",
        },
        {
          key: "general-electricity-conservation",
          label: "Conserve electricity to conserve costs",
          competencyPrompt: "Member understands electricity should be conserved.",
          notesPrompt: "Include heater, lighting, and appliance guidance.",
        },
        {
          key: "general-reporting-damage",
          label: "Reporting of damage",
          competencyPrompt: "Member knows how to report lodge damage.",
          notesPrompt: "Link to issue reporting workflow if implemented.",
        },
        {
          key: "general-allocated-duties",
          label: "Requirement to carry out allocated duties",
          competencyPrompt:
            "Member understands they must complete allocated lodge duties.",
          notesPrompt: "Link to chores module if implemented.",
        },
        {
          key: "general-car-parking",
          label: "Car parking in designated overnight areas",
          competencyPrompt: "Member knows where overnight parking is allowed.",
          notesPrompt: "Include local parking map or written directions.",
        },
        {
          key: "general-consideration",
          label: "Consideration for other lodge residents",
          competencyPrompt:
            "Member understands shared-lodge behaviour expectations.",
          notesPrompt: "Include noise, shared spaces, cleaning, and quiet hours.",
        },
        {
          key: "general-changing-water-tanks",
          label: "Changing water tanks",
          competencyPrompt:
            "Member knows the process for changing water tanks where required.",
          notesPrompt: "Include step-by-step procedure and safety notes.",
          requiresDemonstration: true,
        },
        {
          key: "general-rubbish-recycling",
          label: "Rubbish and recycling",
          competencyPrompt:
            "Member understands rubbish and recycling requirements.",
          notesPrompt: "Include what must be removed from site.",
        },
        {
          key: "general-fax-machine",
          label: "Operating fax machine and changing paper, if still used",
          competencyPrompt:
            "Member knows how to operate legacy communications equipment if still used.",
          notesPrompt:
            "Treat as legacy. Replace with current communication equipment if the fax is no longer used.",
        },
      ],
    },
  ],
};

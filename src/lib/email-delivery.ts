type EnvMap = Record<string, string | undefined>;

type EmailDeliveryMode = "aws-ses" | "smtp-relay";

interface EmailTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
}

export interface ResolvedEmailDeliveryConfig {
  ok: boolean;
  mode: EmailDeliveryMode | "invalid";
  modeLabel: string;
  issues: string[];
  warnings: string[];
  transportOptions: EmailTransportOptions | null;
}

function readEnv(env: EnvMap, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parseBooleanFlag(
  env: EnvMap,
  name: string,
  issues: string[],
): boolean | undefined {
  const raw = readEnv(env, name);
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  issues.push(`${name} must be true or false`);
  return undefined;
}

function parsePort(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return null;
  }
  return parsed;
}

export function resolveEmailDeliveryConfigFromEnv(
  env: EnvMap,
): ResolvedEmailDeliveryConfig {
  const issues: string[] = [];
  const warnings: string[] = [];

  const useAwsSes = parseBooleanFlag(env, "USE_AWS_SES", issues);
  const useSmtpRelay = parseBooleanFlag(env, "USE_SMTP_RELAY", issues);

  const selectedModes =
    Number(useAwsSes === true) + Number(useSmtpRelay === true);

  let mode: EmailDeliveryMode | "invalid" = "invalid";
  if (selectedModes === 1) {
    mode = useAwsSes === true ? "aws-ses" : "smtp-relay";
  } else if (selectedModes === 0) {
    // Backward compatibility: if both flags are omitted, use legacy SES mode.
    if (useAwsSes === undefined && useSmtpRelay === undefined) {
      mode = "aws-ses";
      warnings.push(
        "USE_AWS_SES/USE_SMTP_RELAY are not set; defaulting to AWS SES mode for backward compatibility",
      );
    } else {
      issues.push(
        "Exactly one email provider flag must be true (USE_AWS_SES or USE_SMTP_RELAY)",
      );
    }
  } else {
    issues.push("USE_AWS_SES and USE_SMTP_RELAY cannot both be true");
  }

  const emailFrom = readEnv(env, "EMAIL_FROM");
  if (!emailFrom) {
    issues.push("EMAIL_FROM is missing");
  }

  if (mode === "aws-ses") {
    const host =
      readEnv(env, "SMTP_HOST") ?? "email-smtp.ap-southeast-2.amazonaws.com";
    const portRaw = readEnv(env, "SMTP_PORT");
    const port = parsePort(portRaw) ?? 587;
    const user = readEnv(env, "AWS_SES_ACCESS_KEY_ID");
    const pass = readEnv(env, "AWS_SES_SECRET_ACCESS_KEY");

    if (!user) issues.push("AWS_SES_ACCESS_KEY_ID is missing");
    if (!pass) issues.push("AWS_SES_SECRET_ACCESS_KEY is missing");
    if (portRaw && parsePort(portRaw) === null) {
      issues.push("SMTP_PORT must be a valid port number");
    }
    if (!readEnv(env, "SES_SNS_TOPIC_ARN")) {
      warnings.push(
        "SES_SNS_TOPIC_ARN is not set; SES bounce/complaint topic allowlisting is disabled",
      );
    }

    return {
      ok: issues.length === 0,
      mode,
      modeLabel: "AWS SES",
      issues,
      warnings,
      transportOptions:
        user && pass
          ? {
              host,
              port,
              secure: false,
              auth: { user, pass },
            }
          : null,
    };
  }

  if (mode === "smtp-relay") {
    const host = readEnv(env, "EMAIL_SERVER_HOST");
    const portRaw = readEnv(env, "EMAIL_SERVER_PORT");
    const port = parsePort(portRaw);
    const user = readEnv(env, "EMAIL_SERVER_USER");
    const pass = readEnv(env, "EMAIL_SERVER_PASSWORD");

    if (!host) issues.push("EMAIL_SERVER_HOST is missing");
    if (!portRaw) {
      issues.push("EMAIL_SERVER_PORT is missing");
    } else if (port === null) {
      issues.push("EMAIL_SERVER_PORT must be a valid port number");
    }
    if (!user) issues.push("EMAIL_SERVER_USER is missing");
    if (!pass) issues.push("EMAIL_SERVER_PASSWORD is missing");

    return {
      ok: issues.length === 0,
      mode,
      modeLabel: "SMTP Relay",
      issues,
      warnings,
      transportOptions:
        host && port !== null && user && pass
          ? {
              host,
              port,
              secure: false,
              auth: { user, pass },
            }
          : null,
    };
  }

  return {
    ok: false,
    mode,
    modeLabel: "Not configured",
    issues,
    warnings,
    transportOptions: null,
  };
}

export function resolveEmailDeliveryConfig(): ResolvedEmailDeliveryConfig {
  return resolveEmailDeliveryConfigFromEnv(process.env);
}

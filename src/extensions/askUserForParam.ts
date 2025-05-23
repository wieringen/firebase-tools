import * as _ from "lodash";
import * as clc from "colorette";
import { marked } from "marked";

import { Param, ParamOption, ParamType } from "./types";
import * as secretManagerApi from "../gcp/secretManager";
import * as secretsUtils from "./secretsUtils";
import { logPrefix, substituteParams } from "./extensionsHelper";
import { convertExtensionOptionToLabeledList, getRandomString } from "./utils";
import { logger } from "../logger";
import { input, password, confirm, select, checkbox } from "../prompt";
import * as utils from "../utils";
import { ParamBindingOptions } from "./paramHelper";
import { needProjectId } from "../projectUtils";
import { partition } from "../functional";

/**
 * Location where the secret value is stored.
 *
 * Visible for testing.
 */
export enum SecretLocation {
  CLOUD = 1,
  LOCAL,
}

enum SecretUpdateAction {
  LEAVE = 1,
  SET_NEW,
}

/**
 * Validates the user's response for param value against the param spec
 * @param response The user's response
 * @param spec The param spec
 * @return True if the user's response is valid
 */
export function checkResponse(response: string, spec: Param): boolean {
  let valid = true;
  let responses: string[];

  if (spec.required && (response === "" || response === undefined)) {
    utils.logWarning(`Param ${spec.param} is required, but no value was provided.`);
    return false;
  }
  if (spec.type === ParamType.MULTISELECT) {
    responses = response.split(",");
  } else {
    // For Params of type SELECT and STRING, we test against the entire response.
    responses = [response];
  }

  if (spec.validationRegex && !!response) {
    // !!response to ignore empty optional params
    const re = new RegExp(spec.validationRegex);
    for (const resp of responses) {
      if ((spec.required || resp !== "") && !re.test(resp)) {
        const genericWarn =
          `${resp} is not a valid value for ${spec.param} since it` +
          ` does not meet the requirements of the regex validation: "${spec.validationRegex}"`;
        utils.logWarning(spec.validationErrorMessage || genericWarn);
        valid = false;
      }
    }
  }

  if (spec.type && (spec.type === ParamType.MULTISELECT || spec.type === ParamType.SELECT)) {
    for (const r of responses) {
      // A choice is valid if it matches one of the option values.
      const validChoice = spec.options?.some((option) => r === option.value);
      if (r && !validChoice) {
        utils.logWarning(`${r} is not a valid option for ${spec.param}.`);
        valid = false;
      }
    }
  }
  return valid;
}

/**
 * Prompt users for params based on paramSpecs defined by the extension developer.
 * @param args.projectId The projectId for the params
 * @param args.instanceId The instanceId for the params
 * @param args.paramSpecs Array of params to ask the user about, parsed from extension.yaml.
 * @param args.firebaseProjectParams Autopopulated Firebase project-specific params
 * @return Promisified map of env vars to values.
 */
export async function ask(args: {
  projectId: string | undefined;
  instanceId: string;
  paramSpecs: Param[];
  firebaseProjectParams: { [key: string]: string };
  reconfiguring: boolean;
}): Promise<{ [key: string]: ParamBindingOptions }> {
  if (_.isEmpty(args.paramSpecs)) {
    logger.debug("No params were specified for this extension.");
    return {};
  }

  utils.logLabeledBullet(logPrefix, "answer the questions below to configure your extension:");
  const substituted = substituteParams<Param[]>(args.paramSpecs, args.firebaseProjectParams);
  const [advancedParams, standardParams] = partition(substituted, (p) => p.advanced ?? false);
  const result: { [key: string]: ParamBindingOptions } = {};
  const promises = standardParams.map((paramSpec) => {
    return async () => {
      result[paramSpec.param] = await askForParam({
        projectId: args.projectId,
        instanceId: args.instanceId,
        paramSpec: paramSpec,
        reconfiguring: args.reconfiguring,
      });
    };
  });
  if (advancedParams.length) {
    promises.push(async () => {
      const shouldPrompt = await confirm(
        "Do you want to configure any advanced parameters for this instance?",
      );
      if (shouldPrompt) {
        const advancedPromises = advancedParams.map((paramSpec) => {
          return async () => {
            result[paramSpec.param] = await askForParam({
              projectId: args.projectId,
              instanceId: args.instanceId,
              paramSpec: paramSpec,
              reconfiguring: args.reconfiguring,
            });
          };
        });
        await advancedPromises.reduce((prev, cur) => prev.then(cur as any), Promise.resolve());
      } else {
        for (const paramSpec of advancedParams) {
          if (paramSpec.required && paramSpec.default) {
            result[paramSpec.param] = { baseValue: paramSpec.default };
          }
        }
      }
    });
  }
  // chaining together the promises so they get executed one after another
  await promises.reduce((prev, cur) => prev.then(cur as any), Promise.resolve());

  logger.info();
  return result;
}

/**
 * Asks the user for values for the extension parameter.
 * @param args.projectId The projectId we are installing into
 * @param args.instanceId The instanceId we are creating/updating/configuring
 * @param args.paramSpec The spec for the param we are asking about
 * @param args.reconfiguring If true we will reconfigure a secret
 * @return ParamBindingOptions to specify the selected value(s) for the parameter.
 */
export async function askForParam(args: {
  projectId?: string;
  instanceId: string;
  paramSpec: Param;
  reconfiguring: boolean;
}): Promise<ParamBindingOptions> {
  const paramSpec = args.paramSpec;

  let valid = false;
  let response = "";
  let responseForLocal;
  let secretLocations: string[] = [];
  const description = paramSpec.description || "";
  const label = paramSpec.label.trim();
  logger.info(
    `\n${clc.bold(label)}${clc.bold(paramSpec.required ? "" : " (Optional)")}: ${(
      await marked(description)
    ).trim()}`,
  );

  while (!valid) {
    switch (paramSpec.type) {
      case ParamType.SELECT:
        response = await select<string>({
          default: paramSpec.default
            ? getInquirerDefault(_.get(paramSpec, "options", []), paramSpec.default)
            : undefined,
          message:
            "Which option do you want enabled for this parameter? " +
            "Select an option with the arrow keys, and use Enter to confirm your choice. " +
            "You may only select one option.",
          choices: convertExtensionOptionToLabeledList(paramSpec.options as ParamOption[]),
        });
        valid = checkResponse(response, paramSpec);
        break;
      case ParamType.MULTISELECT:
        response = (
          await checkbox<string>({
            default: paramSpec.default
              ? paramSpec.default.split(",").map((def) => {
                  return getInquirerDefault(_.get(paramSpec, "options", []), def);
                })
              : undefined,
            message:
              "Which options do you want enabled for this parameter? " +
              "Press Space to select, then Enter to confirm your choices. ",
            choices: convertExtensionOptionToLabeledList(paramSpec.options as ParamOption[]),
          })
        ).join(",");
        valid = checkResponse(response, paramSpec);
        break;
      case ParamType.SECRET:
        do {
          secretLocations = await promptSecretLocations(paramSpec);
        } while (!isValidSecretLocations(secretLocations, paramSpec));

        if (secretLocations.includes(SecretLocation.CLOUD.toString())) {
          // TODO(lihes): evaluate the UX of this error message.
          const projectId = needProjectId({ projectId: args.projectId });
          response = args.reconfiguring
            ? await promptReconfigureSecret(projectId, args.instanceId, paramSpec)
            : await promptCreateSecret(projectId, args.instanceId, paramSpec);
        }
        if (secretLocations.includes(SecretLocation.LOCAL.toString())) {
          responseForLocal = await promptLocalSecret(args.instanceId, paramSpec);
        }
        valid = true;
        break;
      default:
        // Default to ParamType.STRING
        response = await input({
          default: paramSpec.default,
          message: `Enter a value for ${label}:`,
        });
        valid = checkResponse(response, paramSpec);
    }
  }
  return { baseValue: response, ...(responseForLocal ? { local: responseForLocal } : {}) };
}

function isValidSecretLocations(secretLocations: string[], paramSpec: Param): boolean {
  if (paramSpec.required) {
    return !!secretLocations.length;
  }
  return true;
}

async function promptSecretLocations(paramSpec: Param): Promise<string[]> {
  if (paramSpec.required) {
    return await checkbox<string>({
      message: "Where would you like to store your secrets? You must select at least one value",
      choices: [
        {
          checked: true,
          name: "Google Cloud Secret Manager (Used by deployed extensions and emulator)",
          // return type of string is not actually enforced, need to manually convert.
          value: SecretLocation.CLOUD.toString(),
        },
        {
          checked: false,
          name: "Local file (Used by emulator only)",
          value: SecretLocation.LOCAL.toString(),
        },
      ],
    });
  }
  return await checkbox<string>({
    message:
      "Where would you like to store your secrets? " +
      "If you don't want to set this optional secret, leave both options unselected to skip it",
    choices: [
      {
        checked: false,
        name: "Google Cloud Secret Manager (Used by deployed extensions and emulator)",
        // return type of string is not actually enforced, need to manually convert.
        value: SecretLocation.CLOUD.toString(),
      },
      {
        checked: false,
        name: "Local file (Used by emulator only)",
        value: SecretLocation.LOCAL.toString(),
      },
    ],
  });
}

async function promptLocalSecret(instanceId: string, paramSpec: Param): Promise<string> {
  let value;
  do {
    utils.logLabeledBullet(logPrefix, "Configure a local secret value for Extensions Emulator");
    value = await input(
      `This secret will be stored in ./extensions/${instanceId}.secret.local.\n` +
        `Enter value for "${paramSpec.label.trim()}" to be used by Extensions Emulator:`,
    );
  } while (!value);
  return value;
}

async function promptReconfigureSecret(
  projectId: string,
  instanceId: string,
  paramSpec: Param,
): Promise<string> {
  const action = await select<SecretUpdateAction>({
    message: `Choose what you would like to do with this secret:`,
    choices: [
      { name: "Leave unchanged", value: SecretUpdateAction.LEAVE },
      { name: "Set new value", value: SecretUpdateAction.SET_NEW },
    ],
  });
  switch (action) {
    case SecretUpdateAction.SET_NEW: {
      let secret;
      let secretName;
      if (paramSpec.default) {
        secret = secretManagerApi.parseSecretResourceName(paramSpec.default);
        secretName = secret.name;
      } else {
        secretName = await generateSecretName(projectId, instanceId, paramSpec.param);
      }
      const secretValue = await password(
        `This secret will be stored in Cloud Secret Manager as ${secretName}.\nEnter new value for ${paramSpec.label.trim()}:`,
      );
      if (secretValue === "" && paramSpec.required) {
        logger.info(`Secret value cannot be empty for required param ${paramSpec.param}`);
        return promptReconfigureSecret(projectId, instanceId, paramSpec);
      } else if (secretValue !== "") {
        if (checkResponse(secretValue, paramSpec)) {
          if (!secret) {
            secret = await secretManagerApi.createSecret(
              projectId,
              secretName,
              secretsUtils.getSecretLabels(instanceId),
            );
          }
          return addNewSecretVersion(projectId, instanceId, secret, paramSpec, secretValue);
        } else {
          return promptReconfigureSecret(projectId, instanceId, paramSpec);
        }
      } else {
        return "";
      }
    }
    case SecretUpdateAction.LEAVE:
    default:
      return paramSpec.default || "";
  }
}

/**
 * Prompts the user to create a secret
 * @param projectId The projectId to create the secret in
 * @param instanceId The instanceId for the secret
 * @param paramSpec The secret param spec
 * @param secretName (Optional) The name to store the secret as
 * @return The resource name of a new secret version or empty string if no secret is created.
 */
export async function promptCreateSecret(
  projectId: string,
  instanceId: string,
  paramSpec: Param,
  secretName?: string,
): Promise<string> {
  const name = secretName ?? (await generateSecretName(projectId, instanceId, paramSpec.param));
  // N.B. Is it actually possible to have a default value for a password?!
  const secretValue =
    (await password({
      message: `This secret will be stored in Cloud Secret Manager (https://cloud.google.com/secret-manager/pricing) as ${name} and managed by Firebase Extensions (Firebase Extensions Service Agent will be granted Secret Admin role on this secret).\nEnter a value for ${paramSpec.label.trim()}:`,
    })) ||
    paramSpec.default ||
    "";
  if (secretValue === "" && paramSpec.required) {
    logger.info(`Secret value cannot be empty for required param ${paramSpec.param}`);
    return promptCreateSecret(projectId, instanceId, paramSpec, name);
  } else if (secretValue !== "") {
    if (checkResponse(secretValue, paramSpec)) {
      const secret = await secretManagerApi.createSecret(
        projectId,
        name,
        secretsUtils.getSecretLabels(instanceId),
      );
      return addNewSecretVersion(projectId, instanceId, secret, paramSpec, secretValue);
    } else {
      return promptCreateSecret(projectId, instanceId, paramSpec, name);
    }
  } else {
    return "";
  }
}

async function generateSecretName(
  projectId: string,
  instanceId: string,
  paramName: string,
): Promise<string> {
  let secretName = `ext-${instanceId}-${paramName}`;
  while (await secretManagerApi.secretExists(projectId, secretName)) {
    secretName += `-${getRandomString(3)}`;
  }
  return secretName;
}

async function addNewSecretVersion(
  projectId: string,
  instanceId: string,
  secret: secretManagerApi.Secret,
  paramSpec: Param,
  secretValue: string,
): Promise<string> {
  const version = await secretManagerApi.addVersion(projectId, secret.name, secretValue);
  await secretsUtils.grantFirexServiceAgentSecretAdminRole(secret);
  return `projects/${version.secret.projectId}/secrets/${version.secret.name}/versions/${version.versionId}`;
}

/**
 * Finds the label or value of a default option if the option is found in options
 * @param options The param options to search for default
 * @param def The value of the default to search for
 * @return The label or value of the default if present or empty string if not.
 */
export function getInquirerDefault(options: ParamOption[], def: string): string {
  const defaultOption = options.find((o) => o.value === def);
  return defaultOption ? defaultOption.label || defaultOption.value : "";
}

import { apiServerPorts, type SimpleLogger, text } from "@lmstudio/lms-common";
import { LMStudioClient, type LMStudioClientConstructorOpts } from "@lmstudio/sdk";
import chalk from "chalk";
import { spawn } from "child_process";
import { option, optional, string } from "cmd-ts";
import { randomBytes } from "crypto";
import { readFile } from "fs/promises";
import { appInstallLocationFilePath, lmsKey2Path } from "./lmstudioPaths.js";
import { type LogLevelArgs } from "./logLevel.js";
import { checkHttpServer } from "./subcommands/server.js";
import { refinedNumber } from "./types/refinedNumber.js";

interface AppInstallLocation {
  path: string;
  argv: Array<string>;
  cwd: string;
}

export const createClientArgs = {
  host: option({
    type: optional(string),
    long: "host",
    description: text`
      If you wish to connect to a remote LM Studio instance, specify the host here. Note that, in
      this case, lms will connect using client identifier "lms-cli-remote-<random chars>", which
      will not be a privileged client, and will restrict usage of functionalities such as
      "lms push".
    `,
  }),
  port: option({
    type: optional(refinedNumber({ integer: true, min: 0, max: 65535 })),
    long: "port",
    description: text`
      The port where LM Studio can be reached. If not provided and the host is set to "127.0.0.1"
      (default), the last used port will be used; otherwise, 1234 will be used.
    `,
  }),
};

interface CreateClientArgs {
  yes?: boolean;
  host?: string;
  port?: number;
}

async function isLocalServerAtPortLMStudioServerOrThrow(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/lmstudio-greeting`);
  if (response.status !== 200) {
    throw new Error("Status is not 200.");
  }
  const json = await response.json();
  if (json?.lmstudio !== true) {
    throw new Error("Not an LM Studio server.");
  }
  return port;
}

async function tryFindLocalAPIServer(): Promise<number | null> {
  return await Promise.any(apiServerPorts.map(isLocalServerAtPortLMStudioServerOrThrow)).then(
    port => port,
    () => null,
  );
}

export async function wakeUpService(logger: SimpleLogger): Promise<boolean> {
  logger.info("Waking up LM Studio service...");
  const appInstallLocationPath = appInstallLocationFilePath;
  logger.debug(`Resolved appInstallLocationPath: ${appInstallLocationPath}`);
  try {
    const appInstallLocation = JSON.parse(
      await readFile(appInstallLocationPath, "utf-8"),
    ) as AppInstallLocation;
    logger.debug(`Read executable pointer:`, appInstallLocation);

    const args: Array<string> = [];
    const { path, argv, cwd } = appInstallLocation;
    if (argv[1] === ".") {
      // We are in development environment
      args.push(".");
    }
    // Also add the headless flag
    args.push("--run-as-service");

    logger.debug(`Spawning process:`, { path, args, cwd });

    const env = {
      ...(process.platform === "linux" ? { DISPLAY: ":0" } : {}),
      ...process.env,
    };

    const child = spawn(path, args, { cwd, detached: true, stdio: "ignore", env });
    child.unref();

    logger.debug(`Process spawned`);
    return true;
  } catch (e) {
    logger.debug(`Failed to launch application`, e);
    return false;
  }
}

export interface CreateClientOpts {}
const lmsKey = "<LMS-CLI-LMS-KEY>";

export async function createClient(
  logger: SimpleLogger,
  args: CreateClientArgs & LogLevelArgs,
  _opts: CreateClientOpts = {},
) {
  let { host, port } = args;
  let isRemote = true;
  if (host === undefined) {
    isRemote = false;
    host = "127.0.0.1";
  } else if (host.includes("://")) {
    logger.error("Host should not include the protocol.");
    process.exit(1);
  } else if (host.includes(":")) {
    logger.error(
      `Host should not include the port number. Use ${chalk.yellowBright("--port")} instead.`,
    );
    process.exit(1);
  }
  let auth: LMStudioClientConstructorOpts;
  if (isRemote) {
    // If connecting to a remote server, we will use a random client identifier.
    auth = {
      clientIdentifier: `lms-cli-remote-${randomBytes(18).toString("base64")}`,
    };
  } else {
    // Not remote. We need to check if this is a production build.
    if (lmsKey.startsWith("<") && !process.env.LMS_FORCE_PROD) {
      // lmsKey not injected and we did not force prod, this is not a production build.
      logger.warnText`
        You are using a development build of lms-cli. Privileged features such as "lms push" will
        not work.
      `;
      auth = {
        clientIdentifier: "lms-cli-dev",
      };
    } else {
      const lmsKey2 = (await readFile(lmsKey2Path, "utf-8")).trim();
      auth = {
        clientIdentifier: "lms-cli",
        clientPasskey: lmsKey + lmsKey2,
      };
    }
  }
  if (port === undefined && host === "127.0.0.1") {
    // We will now attempt to connect to the local API server.
    const localPort = await tryFindLocalAPIServer();

    if (localPort !== null) {
      const baseUrl = `ws://${host}:${localPort}`;
      logger.debug(`Found local API server at ${baseUrl}`);
      return new LMStudioClient({ baseUrl, logger, ...auth });
    }

    // At this point, the user wants to access the local LM Studio, but it is not running. We will
    // wake up the service and poll the API server until it is up.

    await wakeUpService(logger);

    // Polling

    for (let i = 1; i <= 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      logger.debug(`Polling the API server... (attempt ${i})`);
      const localPort = await tryFindLocalAPIServer();
      if (localPort !== null) {
        const baseUrl = `ws://${host}:${localPort}`;
        logger.debug(`Found local API server at ${baseUrl}`);

        if (auth.clientIdentifier === "lms-cli") {
          // We need to refetch the lms key due to the possibility of a new key being generated.
          const lmsKey2 = (await readFile(lmsKey2Path, "utf-8")).trim();
          auth = {
            ...auth,
            clientPasskey: lmsKey + lmsKey2,
          };
        }

        return new LMStudioClient({ baseUrl, logger, ...auth });
      }
    }

    logger.error("");
  }

  if (port === undefined) {
    port = 1234;
  }

  logger.debug(`Connecting to server at ${host}:${port}`);
  if (!(await checkHttpServer(logger, port, host))) {
    logger.error(
      text`
        The server does not appear to be running at ${host}:${port}. Please make sure the server
        is running and accessible at the specified address.
      `,
    );
  }
  const baseUrl = `ws://${host}:${port}`;
  logger.debug(`Found server at ${port}`);
  return new LMStudioClient({
    baseUrl,
    logger,
    ...auth,
  });
}

import { createOpencodeClient as createV2OpencodeClient } from "@opencode-ai/sdk/v2/client"

export interface ServerClientFactoryInput {
  directory: string
  serverUrl: URL
}

export function createAuthenticatedServerClient(input: ServerClientFactoryInput) {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"

  return createV2OpencodeClient({
    baseUrl: input.serverUrl.toString(),
    directory: input.directory,
    headers: password
      ? {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        }
      : undefined,
  })
}

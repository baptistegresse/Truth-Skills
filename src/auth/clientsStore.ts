import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Queryable } from "../db/pool.js";

// OAuth clients created by Dynamic Client Registration (RFC 7591). The SDK router validates the
// metadata and generates the client_id before calling registerClient; we only persist it.
export class PgClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly db: Queryable) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const { rows } = await this.db.query<{ info: OAuthClientInformationFull }>(
      "select info from oauth_clients where client_id = $1",
      [clientId],
    );
    return rows[0]?.info;
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    await this.db.query("insert into oauth_clients (client_id, info) values ($1, $2)", [client.client_id, client]);
    return client;
  }
}

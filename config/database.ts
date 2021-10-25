/**
 * Config source: https://git.io/JesV9
 *
 * Feel free to let us know via PR, if you find something broken in this config
 * file.
 */

import Application from '@ioc:Adonis/Core/Application'
import Env from '@ioc:Adonis/Core/Env'
import { DatabaseConfig } from '@ioc:Adonis/Lucid/Database'

const databaseConfig: DatabaseConfig = {
  /*
  |--------------------------------------------------------------------------
  | Connection
  |--------------------------------------------------------------------------
  |
  | The primary connection for making database queries across the application
  | You can use any key from the `connections` object defined in this same
  | file.
  |
  */
  connection: Env.get('DB_CONNECTION'),

  connections: {
    pg: {
      client: 'pg',
      connection: Env.get('PG_CONNECTION_STRING'),
      migrations: {
        naturalSort: false,
      },
      healthCheck: true,
      debug: true,
    },
    sqlite: {
      client: 'sqlite',
      connection: {
        filename: Application.tmpPath('db.sqlite3'),
      },
      migrations: {
        naturalSort: true,
      },
      useNullAsDefault: true,
      healthCheck: false,
      debug: false,
    }
  },
}

export default databaseConfig
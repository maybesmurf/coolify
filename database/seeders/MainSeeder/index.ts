import BaseSeeder from '@ioc:Adonis/Lucid/Seeder'
import Application from '@ioc:Adonis/Core/Application'
export default class IndexSeeder extends BaseSeeder {
  private async runSeeder(seeder: { default: typeof BaseSeeder }) {
    /**
     * Do not run when not in dev mode and seeder is development
     * only
     */
    if (seeder.default.developmentOnly && !Application.inDev) {
      return
    }

    await new seeder.default(this.client).run()
  }

  public async run() {
    try {
      await this.runSeeder(await import('../GitSource'))
      await this.runSeeder(await import('../Application'))
      await this.runSeeder(await import('../DestinationDocker'))
    } catch (error) {
      console.log(error)
    }
  }
}
import Route from '@ioc:Adonis/Core/Route'
import Application from 'App/Models/Application'
import DestinationDocker from 'App/Models/DestinationDocker'
import GitSource from 'App/Models/GitSource'
import jsonwebtoken from 'jsonwebtoken'
import Database from '@ioc:Adonis/Lucid/Database'
import cuid from 'cuid'
import crypto from 'crypto'

import { buildQueue, letsEncryptQueue } from 'Helpers/queue'
import Build from 'App/Models/Build'
import { getNextTransactionId, haproxyInstance, completeTransaction } from 'Helpers/haproxy'
import { HttpRequestRule } from 'Helpers/types'

const buildPacks = ['node', 'static']

Route.group(() => {
  Route.get('/applications', async ({ view }) => {
    const applications = await Database.from('applications').orderBy('created_at')
    return view.render('pages/applications/index', { applications })
  })

  Route.post('/applications/new', async ({ request, response, view }) => {
    const appName = request.input('appName')
    const found = await Application.findBy('name', appName)
    if (found) {
      return view.render('pages/applications/new', { error: "Application with this name is already exists." })
    }
    await Application.create({
      name: appName,
    })
    return response.redirect(`/applications/${appName}`)
  })

  Route.post('/applications/:name/delete', async ({ response, params }) => {
    // TODO: must clear out haproxy configuration
    const applicationFound = await Application.findByOrFail('name', params.name)
    await applicationFound.delete()
    return response.redirect('/')
  })

  Route.get('/applications/:name', async ({ response, params, view, session }) => {
    if (params.name === 'new') return view.render('pages/applications/new')
    let applicationFound = await Application.findByOrFail('name', params.name)
    const gitSources = await (await GitSource.all()).filter((source) => source.githubAppId)
    const dockers = await DestinationDocker.all()
    const builds = await Database.from('builds')
      .select('*')
      .where('application_id', applicationFound.id)
    if (applicationFound) {
      try {
        await applicationFound.load('gitSource')
        await applicationFound.load('destinationDocker')
        await applicationFound.gitSource.load('githubApp')
        const payload = {
          iat: Math.round(new Date().getTime() / 1000),
          exp: Math.round(new Date().getTime() / 1000 + 60),
          iss: applicationFound.gitSource.githubApp.appId,
        }
        const jwtToken = jsonwebtoken.sign(payload, applicationFound.gitSource.githubApp.privateKey, {
          algorithm: 'RS256',
        })
        session.put('githubAppToken', jwtToken)
      } catch (error) { }

      return view.render('pages/applications/name/index', {
        application: applicationFound,
        buildPacks,
        builds,
        dockers,
        gitSources
      })
    }
    return response.redirect('/')
  })

  Route.post('/applications/:name/ssl/force', async ({ params, response }) => {
    const applicationFound = await Application.findByOrFail('name', params.name)
    const transactionId = await getNextTransactionId()
    const httpRules: HttpRequestRule = await haproxyInstance()
      .get(`v2/services/haproxy/configuration/http_request_rules`, {
        searchParams: {
          parent_name: 'http',
          parent_type: 'frontend',
        },
      })
      .json()
    let foundIndex = 0
    if (httpRules.data.length > 0) {
      foundIndex = httpRules.data.find((rule) => {
        if (rule.cond_test.includes(applicationFound.domain)) {
          return rule.index
        }
      })
    }
    await haproxyInstance()
      .post(`v2/services/haproxy/configuration/http_request_rules`, {
        json: {
          index: foundIndex,
          cond: 'if',
          cond_test: `{ hdr(Host) -i ${applicationFound.domain} } !{ ssl_fc }`,
          type: 'redirect',
          redir_type: 'scheme',
          redir_value: 'https',
          redir_code: 301,
        },
        searchParams: {
          transaction_id: transactionId,
          parent_name: 'http',
          parent_type: 'frontend',
        },
      })
      .json()
    await completeTransaction(transactionId)
    await applicationFound.merge({ forceSsl: true }).save()
    return response.redirect(`/applications/${params.name}`)
  })

  Route.post('/applications/:name/ssl/force/disable', async ({ params, response }) => {
    const applicationFound = await Application.findByOrFail('name', params.name)
    const transactionId = await getNextTransactionId()
    const httpRules: HttpRequestRule = await haproxyInstance()
      .get(`v2/services/haproxy/configuration/http_request_rules`, {
        searchParams: {
          parent_name: 'http',
          parent_type: 'frontend',
        },
      })
      .json()
    let foundIndex = 0
    if (httpRules.data.length > 0) {
      const foundRule = httpRules.data.find((rule) => {
        if (rule.cond_test.includes(applicationFound.domain)) {
          return rule
        }
      })
      if (foundRule) foundIndex = foundRule.index
    }

    await haproxyInstance()
      .delete(`v2/services/haproxy/configuration/http_request_rules/${foundIndex}`, {
        searchParams: {
          transaction_id: transactionId,
          parent_name: 'http',
          parent_type: 'frontend',
        },
      })
      .json()
    await completeTransaction(transactionId)
    await applicationFound.merge({ forceSsl: false }).save()
    return response.redirect(`/applications/${params.name}`)
  })
  Route.post('/applications/:name/ssl/generate', async ({ params, response }) => {
    try {
      const buildId = cuid()
      const applicationFound = await Application.findByOrFail('name', params.name)
      await applicationFound.load('destinationDocker')
      await applicationFound.load('gitSource')
      await applicationFound.gitSource.load('githubApp')
      await letsEncryptQueue.add(buildId, { build_id: buildId, ...applicationFound.toJSON() })
      return response.redirect(`/applications/${params.name}`)
    } catch (error) {
      return response.redirect(`/applications/${params.name}`)
    }
  })

  Route.post('/applications/:name/deploy', async ({ params, response }) => {
    try {
      const buildId = cuid()
      const applicationFound = await Application.findByOrFail('name', params.name)
      await applicationFound.load('destinationDocker')
      await applicationFound.load('gitSource')
      await applicationFound.gitSource.load('githubApp')
      if (!applicationFound.configHash) {
        const configHash = crypto
          .createHash('sha256')
          .update(
            JSON.stringify({
              buildPack: applicationFound.buildPack,
              port: applicationFound.port,
              installCommand: applicationFound.installCommand,
              buildCommand: applicationFound.buildCommand,
              startCommand: applicationFound.startCommand,
            })
          )
          .digest('hex')
        await applicationFound.merge({ configHash }).save()
      }
      await buildQueue.add(buildId, { build_id: buildId, ...applicationFound.toJSON() })
      return response.redirect(`/applications/${params.name}/logs/${buildId}`)
    } catch (error) {
      return response.redirect(`/applications/${params.name}`)
    }
  })

  Route.get('/applications/:name/logs/:buildId', async ({ params, view }) => {
    const applicationFound = await Application.findByOrFail('name', params.name)
    await applicationFound.load('gitSource')
    let logs
    try {
      logs = await Database.from('build_logs').where('build_id', params.buildId).orderBy('time')
    } catch (error) {
      console.log(error)
    }
    const build = await Build.findOrFail(params.buildId)
    return view.render('pages/applications/name/logs/log', {
      logs,
      status: build.status,
      application: applicationFound
    })
  })

  Route.get('/applications/:name/source', async ({ params, view }) => {
    const applicationFound = await Application.findByOrFail('name', params.name)
    const gitSources = await (await GitSource.all()).filter((source) => source.githubAppId)
    await applicationFound.load('gitSource')
    await applicationFound.gitSource.load('githubApp')
    return view.render('pages/applications/name/source', {
      application: applicationFound,
      gitSources,
    })
    // if (applicationFound) {
    //   try {
    //     await applicationFound.load('gitSource')
    //     await applicationFound.gitSource.load('githubApp')
    //   } catch (error) { }
    //   return view.render('pages/applications/name/source', {
    //     application: applicationFound,
    //     gitSources,
    //   })
    // }
    // return view.render('pages/applications/name/source')
  })

  Route.post('/applications/:name/source', async ({ response, params, request }) => {
    const gitSourceId = request.input('gitSourceId')
    const applicationFound = await Application.findByOrFail('name', params.name)
    const gitSourceFound = await GitSource.findOrFail(gitSourceId)
    if (gitSourceFound && gitSourceFound.githubAppId && applicationFound) {
      if (applicationFound.gitSourceId !== gitSourceId) {
        applicationFound.repository = ''
        applicationFound.branch = ''
      }
      await gitSourceFound.related('applications').save(applicationFound)
    }
    return response.redirect(`/applications/${params.name}`)
  })

  Route.get('/applications/:name/repository', async ({ params, view, session }) => {
    const applicationFound = await Application.findByOrFail('name', params.name)
    await applicationFound.load('gitSource')
    await applicationFound.gitSource.load('githubApp')
    const payload = {
      iat: Math.round(new Date().getTime() / 1000),
      exp: Math.round(new Date().getTime() / 1000 + 60),
      iss: applicationFound.gitSource.githubApp.appId,
    }
    const jwtToken = jsonwebtoken.sign(payload, applicationFound.gitSource.githubApp.privateKey, {
      algorithm: 'RS256',
    })
    session.put('githubAppToken', jwtToken)

    return view.render('pages/applications/name/repository', {
      application: applicationFound
    })

  })

  Route.post('/applications/:name/repository', async ({ response, request, params }) => {
    const applicationFound = await Application.findByOrFail('name', params.name)
    const { repository, branch } = request.body()
    if (applicationFound && repository && branch) {
      await applicationFound.merge({ branch, repository }).save()
    }
    return response.redirect(`/applications/${params.name}`)
  })

  Route.get('/applications/:name/destination', async ({ params, view }) => {
    const applicationFound = await Application.findByOrFail('name', params.name)
    await applicationFound.load('gitSource')
    const dockers = await DestinationDocker.all()
    return view.render('pages/applications/name/destination', { dockers, application: applicationFound })
  })

  Route.post('/applications/:name/destination', async ({ request, params, response }) => {
    const { destination } = request.body()
    const applicationFound = await Application.findByOrFail('name', params.name)
    const destinationFound = await DestinationDocker.findOrFail(destination)
    if (applicationFound && destinationFound) {
      await destinationFound.related('applications').save(applicationFound)
    }
    return response.redirect(`/applications/${params.name}`)
  })

  Route.post('/applications/:name/configuration', async ({ request, params, response }) => {
    const {
      buildPack,
      port,
      installCommand,
      buildCommand,
      startCommand,
      domain,
      baseDirectory,
      publishDirectory,
    } = request.body()
    try {
      const applicationFound = await Application.findByOrFail('name', params.name)
      if (applicationFound.domain !== domain) {
        await applicationFound
          .merge({
            buildPack,
            port,
            installCommand,
            buildCommand,
            startCommand,
            domain,
            oldDomain: applicationFound.domain,
            baseDirectory,
            publishDirectory,
          })
          .save()
      } else {
        await applicationFound
          .merge({
            buildPack,
            port,
            installCommand,
            buildCommand,
            startCommand,
            domain,
            baseDirectory,
            publishDirectory,
          })
          .save()
      }
      return response.redirect().back()
    } catch (error) {
      return response.redirect().back()
    }

  })

  Route.get('/applications/:name/buildpack', async ({ view, params }) => {
    const applicationFound = await Application.findByOrFail('name', params.name)
    await applicationFound.load('gitSource')
    return view.render('pages/applications/name/buildpack', { buildPacks, application: applicationFound })
  })

  Route.post('/applications/:name/buildpack', async ({ request, response, params }) => {
    const { buildPack } = request.body()
    const applicationFound = await Application.findByOrFail('name', params.name)
    await applicationFound.merge({ buildPack }).save()
    response.redirect(`/applications/${params.name}`)
  })

  Route.get('/sources', async ({ view }) => {
    const gitSources = await GitSource.query().preload('githubApp')
    return view.render('pages/sources/index', { gitSources })
  })

  Route.get('/sources/new', async ({ view }) => {
    return view.render('pages/sources/new')
  })

  Route.post('/sources/new', async ({ request, response, view }) => {
    const { name, type, htmlUrl, apiUrl, organization } = request.body()
    console.log({ name, type, htmlUrl, apiUrl, organization })
    try {
      await GitSource.findByOrFail('name', name)
      return view.render('pages/sources/new', { error: 'Name already in use.' })
    } catch (error) {
      await GitSource.create({ name, type, htmlUrl, apiUrl, organization })
      return response.redirect('/sources')
    }
  })

  Route.delete('/sources/delete', async ({ request, response }) => {
    const { gitId } = request.body()
    try {
      const gitSource = await GitSource.findOrFail(gitId)
      await gitSource.delete()
      return response.send({ message: 'Git Source deleted successfully.' })
    } catch (error) {
      return response.status(500).send({ error: 'Cannot delete Git Source.' })
    }

  })

  Route.get('/destinations', async ({ view }) => {
    const dockers = await Database.from('destination_dockers').orderBy('created_at')
    return view.render('pages/destinations/index', { dockers })
  })

  Route.get('/destinations/new', async ({ view }) => {
    return view.render('pages/destinations/new')
  })

  Route.post('/destinations/new', async ({ view, request, response }) => {
    const { name, engine, network } = request.body()
    let { isSwarm } = request.body()
    try {
      await DestinationDocker.findByOrFail('name', name)
      return view.render('pages/destinations/new', { error: 'Name already in use.' })
    } catch (error) {
      if (!isSwarm) {
        isSwarm = 0
      } else {
        isSwarm = 1
      }
      await DestinationDocker.create({ name, isSwarm, engine, network })
      return response.redirect('/destinations')
    }
  })

  Route.get('/databases', async ({ view }) => {
    return view.render('pages/databases/index')
  })

  Route.get('/services', async ({ view }) => {
    return view.render('pages/services/index')
  })



}).middleware(({ view, request }, next) => {
  view.share({
    name: request.params().name
  })
  return next()
})
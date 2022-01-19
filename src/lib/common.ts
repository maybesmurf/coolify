import child from 'child_process'
import util from 'util'
import { dev } from '$app/env';
import * as Sentry from '@sentry/node';
import { uniqueNamesGenerator, Config, adjectives, colors, animals } from 'unique-names-generator';

import * as db from '$lib/database';
import { buildLogQueue } from './queues'

import { version as currentVersion } from '../../package.json';
import { dockerInstance } from './docker';
import dayjs from 'dayjs';

try {
    if (!dev) {
        Sentry.init({
            dsn: process.env['COOLIFY_SENTRY_DSN'],
            tracesSampleRate: 0,
        });
    }
} catch (err) {
    console.log('Could not initialize Sentry, no worries.')
}


const customConfig: Config = {
    dictionaries: [adjectives, colors, animals],
    style: 'capital',
    separator: ' ',
    length: 3,
};

export const version = currentVersion;
export const asyncExecShell = util.promisify(child.exec)
export const asyncSleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay))
export const sentry = Sentry

export const uniqueName = () => uniqueNamesGenerator(customConfig);

export const saveBuildLog = async ({ line, buildId, applicationId }) => {
    const addTimestamp = `${generateTimestamp()} ${line}`;
    return await buildLogQueue.add(buildId, { buildId, line: addTimestamp, applicationId })
}

export const isTeamIdTokenAvailable = (request) => {
    const cookie = request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('teamId='))?.split('=')[1]
    if (!cookie) {
        return getTeam(request)
    } else {
        return cookie
    }
}

export const getTeam = (request) => {
    const teamIdCookie = request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('teamId='))?.split('=')[1]
    if (teamIdCookie) { return teamIdCookie }

    const teamIdSession = request.locals.session.data.teamId
    if (teamIdSession) { return teamIdSession }

    return null
}

export const getUserDetails = async (request, isAdminRequired = true) => {
    try {
        const teamId = getTeam(request)
        const userId = request.locals.session.data.uid || null
        const { permission = 'read' } = await db.prisma.permission.findFirst({ where: { teamId, userId }, select: { permission: true }, rejectOnNotFound: true })
        const payload = {
            teamId,
            userId,
            permission,
            status: 200,
            body: {
                message: 'OK'
            }
        }
        if (isAdminRequired && permission !== 'admin' && permission !== 'owner') {
            payload.status = 401
            payload.body.message = 'You do not have permission to do this. \nAsk an admin to modify your permissions.'
        }

        return payload
    } catch (err) {
        // console.log(err)
        return {
            teamId: null,
            userId: null,
            permission: 'read',
            status: 401,
            body: {
                message: 'You do not have permission to do this. \nAsk an admin to modify your permissions.'
            }
        }
    }

}

export function getEngine(engine) {
    return engine === '/var/run/docker.sock' ? 'unix:///var/run/docker.sock' : `tcp://${engine}:2375`
}

export const removeDestinationDocker = async ({ id, destinationDocker }) => {
    const docker = dockerInstance({ destinationDocker })
    try {
        const container = docker.engine.getContainer(id)
        if (container) {
            await container.stop()
            await container.remove()
        }
    } catch (error) {
        console.log(error)
    }
}

export const removePreviewDestinationDocker = async ({ id, destinationDocker, pullmergeRequestId }) => {
    try {
        const docker = dockerInstance({ destinationDocker })
        await docker.engine.getContainer(`${id}-${pullmergeRequestId}`).stop()
        await docker.engine.getContainer(`${id}-${pullmergeRequestId}`).remove()
    } catch (error) {
        if (error.statusCode === 404) {
            throw {
                message: 'Nothing to do.'
            }
        }
        throw error
    }

}

export const removeAllPreviewsDestinationDocker = async ({ id, destinationDocker }) => {
    const docker = dockerInstance({ destinationDocker })
    const listContainers = await docker.engine.listContainers({ filters: { network: [destinationDocker.network] } })
    const containers = listContainers.filter((container) => {
        return container.Image.startsWith(id)
    })
    const previews = []
    for (const container of containers) {
        const preview = container.Image.split('-')[1]
        if (preview) previews.push(preview)
        try {
            if (docker.engine.getContainer(container.Id)) {
                await docker.engine.getContainer(container.Id).stop()
                await docker.engine.getContainer(container.Id).remove()
            }
        } catch (error) {
            console.log(error)
        }

    }
    return previews
}

export const createDirectories = async ({ repository, buildId }) => {
    const repodir = `/tmp/build-sources/${repository}/`
    const workdir = `/tmp/build-sources/${repository}/${buildId}`

    await asyncExecShell(`mkdir -p ${workdir}`)

    return {
        workdir, repodir
    }
}


export function generateTimestamp() {
    return `${dayjs().format('HH:mm:ss.SSS')} `;
}

export function getDomain(domain) {
    return domain?.replace('https://', '').replace('http://', '')
}
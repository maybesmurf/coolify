import { asyncExecShell, getEngine, getUserDetails } from '$lib/common';
import * as db from '$lib/database';
import { stopDatabase } from '$lib/database';
import { dockerInstance } from '$lib/docker';
import { deleteProxy } from '$lib/haproxy';
import type { RequestHandler } from '@sveltejs/kit';

export const del: RequestHandler<Locals, FormData> = async (request) => {
    const { teamId, status, body } = await getUserDetails(request);
    if (status === 401) return { status, body }
    const { id } = request.params
    try {
        const database = await db.getDatabase({ id, teamId })
        const everStarted = await stopDatabase(database)
        await db.removeDatabase({ id })
        if (everStarted) await deleteProxy({ id })
        return {
            status: 200
        }
    } catch (error) {
        console.error(error)
        return {
            status: 500
        }
    }

}
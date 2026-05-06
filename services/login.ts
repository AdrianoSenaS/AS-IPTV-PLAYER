import { setDbValue } from '@/services/local-db';
import { normalizeXtreamServerUrl, syncServerFromLogin } from '@/services/account-settings';

export const LoginUserStream = async (username:any, user: any, password: any, url: any) => {
    try {
        const normalizedUrl = await normalizeXtreamServerUrl(String(url || ''));
        const urlApi = `${normalizedUrl}/player_api.php?username=${user}&password=${password}`;
        const response = await fetch(urlApi);
        if (!response.ok)
            return `HTTP error! Status: ${response.status}`

        const data = await response.json();
        const userInfo = data.user_info;
        const serverInfo = data.server_info;

        if (userInfo.status === "Active") {
            await Promise.all([
                setDbValue('name', username),
                setDbValue('username', user),
                setDbValue('password', password),
                setDbValue('url', normalizedUrl),
                setDbValue('userInfo', JSON.stringify(userInfo)),
                setDbValue('serverInfo', JSON.stringify(serverInfo)),
                setDbValue('session.server.credentials.v1', {
                    name: username,
                    username: user,
                    password,
                    url: normalizedUrl,
                    userInfo,
                    serverInfo,
                    savedAt: new Date().toISOString(),
                }),
            ]);
            await syncServerFromLogin({
                displayName: username,
                url: normalizedUrl,
                username: user,
                password,
            })
            return "Ok"
        }


    } catch (ex) {
        return ex;
    }
}
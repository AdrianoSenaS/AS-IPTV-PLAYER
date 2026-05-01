import { setDbValue } from '@/services/local-db';
import { syncServerFromLogin } from '@/services/account-settings';

export const LoginUserStream = async (username:any, user: any, password: any, url: any) => {
    try {
        const urlApi = `${url}/player_api.php?username=${user}&password=${password}`;
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
                setDbValue('url', url),
                setDbValue('userInfo', JSON.stringify(userInfo)),
                setDbValue('serverInfo', JSON.stringify(serverInfo)),
                setDbValue('session.server.credentials.v1', {
                    name: username,
                    username: user,
                    password,
                    url,
                    userInfo,
                    serverInfo,
                    savedAt: new Date().toISOString(),
                }),
            ]);
            await syncServerFromLogin({
                displayName: username,
                url,
                username: user,
                password,
            })
            return "Ok"
        }


    } catch (ex) {
        return ex;
    }
}
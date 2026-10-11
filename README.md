# My-Personal-Compose

Docker Compose for the personal applications. It sits next to the repositories and builds them from there:

```
Repos/
├── My-Personal-Compose/     <- run compose here
├── .NET-Web-Api-Toolkit/    local NuGet feed (bin/Packages)
├── Safeguard-Backend/       (../Safeguard-Backend)
├── Safeguard-Frontend/
├── Gameout-Backend/
└── Gameout-Frontend/
```

Infrastructure is **shared**: one PostgreSQL and one MinIO serve every application. Each application has its own database and user on the PostgreSQL server (`safeguard`, `gameout`), and can't open the other's.

| Service | Host address | |
|---|---|---|
| Safeguard (web) | http://localhost:8100 | |
| Safeguard API | http://localhost:8101 | |
| Gameout (web) | http://localhost:8200 | |
| Gameout API | http://localhost:8201 | Swagger: `/swagger` |
| PostgreSQL | localhost:5432 | user `postgres` (admin), `safeguard`, `gameout` |
| MinIO | http://localhost:9000, console http://localhost:9001 | |
| Portainer | https://localhost:9443 | user `admin`, password `PORTAINER_ADMIN_PASSWORD` |

Data lives in **`D:\volumes`** (`postgres`, `minio`, `portainer`). Ports, passwords and keys live in `.env`.

## How it runs

Docker Engine runs in its own WSL distro, `docker` (no Docker Desktop). That distro mounts the Windows drives with Linux permissions (`metadata`), so the data folders can live in `D:\volumes` as plain folders, PostgreSQL included (it refuses a data folder without Linux ownership and permissions). Published ports reach Windows through WSL's localhost forwarding.

`compose.ps1` runs `docker compose` in that distro, from this folder, and keeps the distro alive (WSL stops a distro seconds after its last process ends, containers included).

The `docker` distro shares the WSL network with WSL-Vpn's Ubuntu: Docker is set up not to change the FORWARD policy (the VPN tunnel depends on it) and to use networks in `100.89.0.0/24` and `100.90.0.0/16`, away from the usual company and home ranges (see `wsl/install-docker.sh`).

## Packages

Gameout uses `Web.Api.Toolkit.*`. They come from a **local NuGet feed**: the `.NET-Web-Api-Toolkit` repository cloned next to the others, whose build writes the packages to `bin\Packages`. Each consuming repository has a `nuget.config` pointing at `../.NET-Web-Api-Toolkit/bin/Packages` (and allows `Web.Api.Toolkit.*` only from there). Compose hands that folder to the Docker build, so no token or package server is needed.

```powershell
git clone https://github.com/VictorAlvesFarias/.NET-Web-Api-Toolkit ..\.NET-Web-Api-Toolkit
dotnet build ..\.NET-Web-Api-Toolkit\Web.Api.Toolkit.sln     # writes bin\Packages\*.nupkg
```

After changing the toolkit, bump `Version` in its `Directory.Build.props`, build it again and update the `PackageReference` versions in the applications. Build the solution (not a single project): the output folder comes from `$(SolutionDir)`.

## First run

1. Create the `docker` distro with Docker Engine (once; downloads Ubuntu into `D:\wsl\docker`):

   ```powershell
   .\wsl\setup-docker.ps1
   ```

2. Build the packages (see above), if not done yet.

3. `.env`: copy `.env.example` and fill in the empty values. Strong values: `openssl rand -hex 32`; JWT keys: `openssl rand -hex 64` (both APIs sign with HMAC-SHA512).

4. Build and start:

   ```powershell
   .\compose.ps1 up -d --build
   .\compose.ps1 ps
   ```

   On first start PostgreSQL runs `postgres/init/01-databases.sh` (creates the databases and users), and each backend applies its EF Core migrations.

5. (Once) bring the data from the old SQLite databases, see below.

## Moving the SQLite data to PostgreSQL

The backends used to keep their data in `App.db` (SQLite) inside their repositories. `tools/sqlite-import` copies those files into the new databases, keeping ids, users and password hashes:

```powershell
.\compose.ps1 up -d safeguard-backend gameout-backend   # creates the tables
.\compose.ps1 --profile tools run --rm sqlite-import safeguard
.\compose.ps1 --profile tools run --rm sqlite-import gameout
```

- It reads a copy of `App.db` (including the `-wal` file), so the originals are never touched.
- It refuses to run when the target tables already have rows; `--force` replaces them.
- At the end it compares the row count of every table and continues the id sequences after the copied ids.
- Gameout's `App.db` is older than the current model: its `IsDeleted`/`DeletedAt` columns no longer exist (the model uses `Deleted`/`DaleteDate`). No file was marked as deleted in them, so nothing is lost; the tool lists these columns as warnings.

## Everyday commands

```powershell
.\compose.ps1 up -d --build gameout-backend    # rebuild one application after changing it
.\compose.ps1 logs -f safeguard-backend
.\compose.ps1 down                             # stop (data stays in D:\volumes)
```

To erase everything, stop the stack and delete the folders in `D:\volumes`.

Changing an application's API address only needs the frontend recreated, not rebuilt: the frontends read `/environment.js`, generated at container start from `API_URL`.

## Adding an application

1. Give the repository a `Dockerfile` (and a `nuget.config` like Gameout's if it uses the toolkit) and add its services here with `build.context: ../<Repository>`.
2. Database: add a password variable and a `create_database <name> "$<NAME>_DB_PASSWORD"` line to `postgres/init/01-databases.sh`. That script only runs when the data folder is created, so on an existing installation run the same statements once:

   ```powershell
   .\compose.ps1 exec postgres psql -U postgres -c "CREATE ROLE myapp LOGIN PASSWORD '...';" -c "CREATE DATABASE myapp OWNER myapp;"
   ```

3. Point it at `postgres` and `minio` by service name.

## Notes

- **Portainer** manages this Docker host (containers, images, volumes, logs) through the Docker socket of the `docker` distro. Its certificate is self-signed, so the browser warns once. The admin password from `.env` is only used on the first start; afterwards change it in Portainer. Its HTTP port (9000) is not published, since MinIO uses it.
- **MinIO image**: the official `minio/minio` image is no longer public. `pgsty/minio` is a maintained community build of the same server (same binary, command and volume).
- **Presigned URLs**: inside Docker the Gameout API reaches MinIO as `minio:9000`, but download and upload URLs are used by the browser and by Gameout-Driver on Windows, so they are signed for `GAMEOUT_MINIO_PUBLIC_ENDPOINT` (`localhost:9000`).
- **Gameout-Driver** runs on Windows (tray app), outside Compose, and only talks to the Gameout API over HTTP (`http://localhost:8201`, its default) with an API key generated on the Gameout site. Uploads go straight to MinIO through presigned URLs.
- **Local development** (`dotnet run`) also needs PostgreSQL: `appsettings.json` points at `localhost:5432` with user and password `safeguard`/`gameout`. Either start only the database (`.\compose.ps1 up -d postgres`) with those passwords in `.env`, or override `ConnectionStrings__DefaultConnection`.
- **Performance**: `D:\volumes` and the repositories are Windows folders seen from Linux, which is slower than Docker's own disk. Fine for personal use; builds read the sources over that bridge too.

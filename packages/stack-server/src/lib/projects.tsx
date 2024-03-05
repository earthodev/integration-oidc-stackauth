import { OauthProviderConfigJson, ProjectJson, ServerUserJson } from "@stackframe/stack-shared";
import { Prisma, ProxiedOauthProviderType, StandardOauthProviderType } from "@prisma/client";
import { prismaClient } from "@/prisma-client";
import { decodeAccessToken } from "./access-token";
import { getServerUser } from "./users";
import { generateUuid } from "@stackframe/stack-shared/dist/utils/uuids";
import { EmailConfigJson, SharedProvider, StandardProvider, sharedProviders, standardProviders } from "@stackframe/stack-shared/dist/interface/clientInterface";
import { typedToUppercase } from "@stackframe/stack-shared/dist/utils/strings";
import { OauthProviderUpdateOptions, ProjectUpdateOptions } from "@stackframe/stack-shared/dist/interface/adminInterface";


function toDBSharedProvider(type: SharedProvider): ProxiedOauthProviderType {
  return ({
    "shared-github": "GITHUB",
    "shared-google": "GOOGLE",
    "shared-facebook": "FACEBOOK",
    "shared-microsoft": "MICROSOFT",
  } as const)[type];
}

function toDBStandardProvider(type: StandardProvider): StandardOauthProviderType {
  return ({
    "github": "GITHUB",
    "facebook": "FACEBOOK",
    "google": "GOOGLE",
    "microsoft": "MICROSOFT",
  } as const)[type];
}

function fromDBSharedProvider(type: ProxiedOauthProviderType): SharedProvider {
  return ({
    "GITHUB": "shared-github",
    "GOOGLE": "shared-google",
    "FACEBOOK": "shared-facebook",
    "MICROSOFT": "shared-microsoft",
  } as const)[type];
}

function fromDBStandardProvider(type: StandardOauthProviderType): StandardProvider {
  return ({
    "GITHUB": "github",
    "FACEBOOK": "facebook",
    "GOOGLE": "google",
    "MICROSOFT": "microsoft",
  } as const)[type];
}


const fullProjectInclude = {
  config: {
    include: {
      oauthProviderConfigs: {
        include: {
          proxiedOauthConfig: true,
          standardOauthConfig: true,
        },
      },
      emailServiceConfig: {
        include: {
          proxiedEmailServiceConfig: true,
          standardEmailServiceConfig: true,
        },
      },
      domains: true,
    },
  },
  configOverride: true,
  _count: {
    select: {
      users: true, // Count the users related to the project
    },
  },
} as const satisfies Prisma.ProjectInclude;
type FullProjectInclude = typeof fullProjectInclude;
type ProjectDB = Prisma.ProjectGetPayload<{ include: FullProjectInclude }> & {
  config: {
    oauthProviderConfigs: (Prisma.OauthProviderConfigGetPayload<
      typeof fullProjectInclude.config.include.oauthProviderConfigs
    >)[],
    emailServiceConfig: Prisma.EmailServiceConfigGetPayload<
      typeof fullProjectInclude.config.include.emailServiceConfig
    > | null,
    domains: Prisma.ProjectDomainGetPayload<
      typeof fullProjectInclude.config.include.domains
    >[],
  },
};

export async function isProjectAdmin(projectId: string, adminAccessToken: string) {
  let decoded;
  try { 
    decoded = await decodeAccessToken(adminAccessToken);
  } catch (error) {
    return false;
  }
  const { userId, projectId: accessTokenProjectId } = decoded;
  if (accessTokenProjectId !== "internal") {
    return false;
  }

  const projectUser = await getServerUser("internal", userId);
  if (!projectUser) {
    return false;
  }

  const allProjects = listProjectIds(projectUser);
  return allProjects.includes(projectId);
}

function listProjectIds(projectUser: ServerUserJson) {
  const serverMetadata = projectUser.serverMetadata;
  if (typeof serverMetadata !== "object" || !(!serverMetadata || "managedProjectIds" in serverMetadata)) {
    throw new Error("Invalid server metadata, did something go wrong?");
  }
  const managedProjectIds = serverMetadata?.managedProjectIds ?? [];
  if (!isStringArray(managedProjectIds)) {
    throw new Error("Invalid server metadata, did something go wrong? Expected string array");
  }

  return managedProjectIds;
}

export async function listProjects(projectUser: ServerUserJson): Promise<ProjectJson[]> {
  const managedProjectIds = listProjectIds(projectUser);

  const projects = await prismaClient.project.findMany({
    where: {
      id: {
        in: managedProjectIds,
      },
    },
    include: fullProjectInclude,
  });

  return projects.map(p => projectJsonFromDbType(p));
}

export async function createProject(
  projectUser: ServerUserJson,
  projectOptions: Pick<ProjectJson, "displayName" | "description"> & Pick<ProjectJson['evaluatedConfig'], 'allowLocalhost' | 'credentialEnabled'>
): Promise<ProjectJson> {
  if (projectUser.projectId !== "internal") {
    throw new Error("Only internal project users can create projects");
  }

  const project = await prismaClient.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        id: generateUuid(),
        isProductionMode: false,
        displayName: projectOptions.displayName,
        description: projectOptions.description,
        config: {
          create: {
            allowLocalhost: projectOptions.allowLocalhost,
            credentialEnabled: projectOptions.credentialEnabled,
            oauthProviderConfigs: {
              create: (['github', 'facebook', 'google', 'microsoft'] as const).map((id) => ({
                id,
                proxiedOauthConfig: {
                  create: {                
                    type: typedToUppercase(id),
                  }
                },
                projectUserOauthAccounts: {
                  create: []
                },
              })),
            },
          },
        },
      },
      include: fullProjectInclude,
    });

    const projectUserTx = await tx.projectUser.findUniqueOrThrow({
      where: {
        projectId_projectUserId: {
          projectId: "internal",
          projectUserId: projectUser.id,
        },
      },
    });

    const serverMetadataTx: any = projectUserTx?.serverMetadata ?? {};

    await tx.projectUser.update({
      where: {
        projectId_projectUserId: {
          projectId: "internal",
          projectUserId: projectUserTx.projectUserId,
        },
      },
      data: {
        serverMetadata: {
          ...serverMetadataTx ?? {},
          managedProjectIds: [
            ...serverMetadataTx?.managedProjectIds ?? [],
            project.id,
          ],
        },
      },
    });

    return project;
  });

  return projectJsonFromDbType(project);
}

export async function getProject(projectId: string): Promise<ProjectJson | null> {
  return await updateProject(projectId, {});
}

export async function updateProject(
  projectId: string,
  options: ProjectUpdateOptions
): Promise<ProjectJson | null> {
  // TODO: Validate production mode consistency
  const transaction = [];

  const project = await prismaClient.project.findUnique({
    where: { id: projectId },
    include: fullProjectInclude,
  });

  if (!project) {
    return null;
  }

  if (options.config?.domains) {
    // Fetch current domains
    const currentDomains = await prismaClient.projectDomain.findMany({
      where: { projectConfigId: project.config.id },
    });

    const newDomains = options.config.domains;

    // delete existing domains
    transaction.push(prismaClient.projectDomain.deleteMany({
      where: { projectConfigId: projectId },
    }));

    // create new domains
    newDomains.forEach(domainConfig => {
      transaction.push(prismaClient.projectDomain.create({
        data: {
          projectConfigId: projectId,
          domain: domainConfig.domain,
          handlerPath: domainConfig.handlerPath,
        },
      }));
    });
  }

  if (options.config?.oauthProviders) {
    transaction.push(prismaClient.oauthProviderConfig.deleteMany({
      where: { projectConfigId: project.config.id },
    }));

    options.config.oauthProviders.forEach(providerConfig => {
      if (sharedProviders.includes(providerConfig.type as SharedProvider)) {
        transaction.push(prismaClient.oauthProviderConfig.create({
          data: {
            projectConfigId: project.config.id,
            id: providerConfig.id,
            proxiedOauthConfig: {
              create: {
                type: toDBSharedProvider(providerConfig.type as SharedProvider),
              },
            },
          },
        }));
      } else if (standardProviders.includes(providerConfig.type as StandardProvider)) {
        // make typescript happy
        const typedProviderConfig = providerConfig as OauthProviderUpdateOptions & { type: StandardProvider };

        transaction.push(prismaClient.oauthProviderConfig.create({
          data: {
            projectConfigId: project.config.id,
            id: providerConfig.id,
            standardOauthConfig: {
              create: {
                type: toDBStandardProvider(providerConfig.type as StandardProvider),
                clientId: typedProviderConfig.clientId,
                clientSecret: typedProviderConfig.clientSecret,
                tenantId: typedProviderConfig.tenantId,
              },
            },
          },
        }));
      } else {
        console.error(`Invalid provider type '${providerConfig.type}'`);
      }
    });
  }

  if (options.config?.credentialEnabled !== undefined) {
    // Update credentialEnabled
    transaction.push(prismaClient.projectConfig.update({
      where: { id: project.config.id },
      data: { credentialEnabled: options.config.credentialEnabled },
    }));
  }

  if (options.isProductionMode !== undefined) {
    // Update production mode
    transaction.push(prismaClient.project.update({
      where: { id: projectId },
      data: { isProductionMode: options.isProductionMode },
    }));
  }

  const result = await prismaClient.$transaction(transaction);
  
  const updatedProject = await prismaClient.project.findUnique({
    where: { id: projectId },
    include: fullProjectInclude, // Ensure you have defined this include object correctly elsewhere
  });

  if (!updatedProject) {
    return null;
  }

  return projectJsonFromDbType(updatedProject);
}

function projectJsonFromDbType(project: ProjectDB): ProjectJson {
  let emailConfig: EmailConfigJson | undefined;
  const emailServiceConfig = project.config.emailServiceConfig;
  if (emailServiceConfig) {
    if (emailServiceConfig.proxiedEmailServiceConfig) {
      emailConfig = {
        type: "shared",
        senderName: emailServiceConfig.senderName,
      };
    }
    if (emailServiceConfig.standardEmailServiceConfig) {
      const standardEmailConfig = emailServiceConfig.standardEmailServiceConfig;
      emailConfig = {
        type: "standard",
        host: standardEmailConfig.host,
        port: standardEmailConfig.port,
        username: standardEmailConfig.username,
        password: standardEmailConfig.password,
        senderEmail: standardEmailConfig.senderEmail,
        senderName: emailServiceConfig.senderName,
      };
    }
  }
  return {
    id: project.id,
    displayName: project.displayName,
    description: project.description ?? undefined,
    createdAtMillis: project.createdAt.getTime(),
    userCount: project._count.users,
    isProductionMode: project.isProductionMode,
    evaluatedConfig: {
      id: project.config.id,
      allowLocalhost: project.config.allowLocalhost,
      credentialEnabled: project.config.credentialEnabled,
      domains: project.config.domains.map((domain) => ({
        domain: domain.domain,
        handlerPath: domain.handlerPath,
      })),
      oauthProviders: project.config.oauthProviderConfigs.flatMap((provider): OauthProviderConfigJson[] => {
        if (provider.proxiedOauthConfig) {
          return [{
            id: provider.id,
            type: fromDBSharedProvider(provider.proxiedOauthConfig.type),
          }];
        }
        if (provider.standardOauthConfig) {
          return [{
            id: provider.id,
            type: fromDBStandardProvider(provider.standardOauthConfig.type),
            clientId: provider.standardOauthConfig.clientId,
            clientSecret: provider.standardOauthConfig.clientSecret,
            tenantId: provider.standardOauthConfig.tenantId || undefined,
          }];
        }
        console.error(`Exactly one of the provider configs should be set on provider config '${provider.id}' of project '${project.id}'. Ignoring it`, { project });
        return [];
      }),
      emailConfig,
    },
  };
}

function isStringArray(value: any): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string");
}

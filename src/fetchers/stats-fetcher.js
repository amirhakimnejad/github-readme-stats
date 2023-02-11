// @ts-check
import axios from "axios";
import * as dotenv from "dotenv";
import githubUsernameRegex from "github-username-regex";
import { calculateRank } from "../calculateRank.js";
import { retryer } from "../common/retryer.js";
import {
  CustomError,
  logger,
  MissingParamError,
  request,
  wrapTextMultiline,
  parseOwnerAffiliations,
} from "../common/utils.js";

dotenv.config();

// GraphQL queries.
const GRAPHQL_REPOS_FIELD = `
  repositories(first: 100, after: $after, ownerAffiliations: $ownerAffiliations, orderBy: {direction: DESC, field: STARGAZERS}) {
    totalCount
    nodes {
      name
      stargazers {
        totalCount
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
`;

const GRAPHQL_REPOS_QUERY = `
  query userInfo($login: String!, $after: String, $ownerAffiliations: [RepositoryAffiliation]) {
    user(login: $login, ownerAffiliations: $ownerAffiliations) {
      ${GRAPHQL_REPOS_FIELD}
    }
  }
`;

const GRAPHQL_STATS_QUERY = `
  query userInfo($login: String!, $after: String, $ownerAffiliations: [RepositoryAffiliation]) {
    user(login: $login) {
      name
      login
      contributionsCollection {
        totalCommitContributions
        restrictedContributionsCount
      }
      repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) {
        totalCount
      }
      pullRequests(first: 1) {
        totalCount
      }
      openIssues: issues(states: OPEN) {
        totalCount
      }
      closedIssues: issues(states: CLOSED) {
        totalCount
      }
      followers {
        totalCount
      }
      ${GRAPHQL_REPOS_FIELD}
    }
  }
`;

/**
 * Stats fetcher object.
 *
 * @param {import('axios').AxiosRequestHeaders} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import('../common/types').Fetcher>} Stats fetcher response.
 */
const fetcher = (variables, token) => {
  const query = !variables.after ? GRAPHQL_STATS_QUERY : GRAPHQL_REPOS_QUERY;
  return request(
    {
      query: `
      query userInfo($login: String!, $ownerAffiliations: [RepositoryAffiliation]) {
        user(login: $login) {
          name
          login
          contributionsCollection {
            totalCommitContributions
            restrictedContributionsCount
          }
          repositoriesContributedTo(contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) {
            totalCount
          }
          pullRequests {
            totalCount
          }
          openIssues: issues(states: OPEN) {
            totalCount
          }
          closedIssues: issues(states: CLOSED) {
            totalCount
          }
          followers {
            totalCount
          }
          repositories(ownerAffiliations: $ownerAffiliations) {
            totalCount
          }
        }
      }
      `,
      variables,
    },
    {
      Authorization: `bearer ${token}`,
    },
  );
};

/**
 * Fetch stats information for a given username.
 *
 * @param {string} username Github username.
 * @param {string[]} ownerAffiliations The owner affiliations to filter by. Default: OWNER.
 * @returns {Promise<import('../common/types').StatsFetcher>} GraphQL Stats object.
 *
 * @description This function supports multi-page fetching if the 'FETCH_MULTI_PAGE_STARS' environment variable is set to true.
 */
const repositoriesFetcher = (variables, token) => {
  return request(
    {
      query: `
      query userInfo($login: String!, $after: String, $ownerAffiliations: [RepositoryAffiliation]) {
        user(login: $login) {
          repositories(first: 100, ownerAffiliations: $ownerAffiliations, orderBy: {direction: DESC, field: STARGAZERS}, after: $after) {
            nodes {
              name
              stargazers {
                totalCount
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
      `,
      variables,
    },
    {
      Authorization: `bearer ${token}`,
    },
  );
};

/**
 * Fetch all the commits for all the repositories of a given username.
 *
 * @param {*} username GitHub username.
 * @returns {Promise<number>} Total commits.
 *
 * @description Done like this because the GitHub API does not provide a way to fetch all the commits. See
 * #92#issuecomment-661026467 and #211 for more information.
 */
const totalCommitsFetcher = async (username) => {
  if (!githubUsernameRegex.test(username)) {
    logger.log("Invalid username");
    return 0;
  }

  // https://developer.github.com/v3/search/#search-commits
  const fetchTotalCommits = (variables, token) => {
    return axios({
      method: "get",
      url: `https://api.github.com/search/commits?q=author:${variables.login}`,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/vnd.github.cloak-preview",
        Authorization: `token ${token}`,
      },
    });
  };

  try {
    let res = await retryer(fetchTotalCommits, { login: username });
    let total_count = res.data.total_count;
    if (!!total_count && !isNaN(total_count)) {
      return res.data.total_count;
    }
  } catch (err) {
    logger.log(err);
  }
  // just return 0 if there is something wrong so that
  // we don't break the whole app
  return 0;
};

/**
 * Fetch all the stars for all the repositories of a given username.
 *
 * @param {string} username GitHub username.
 * @param {boolean} include_orgs Include stats from organization repos.
 * @param {array} repoToHide Repositories to hide.
 * @returns {Promise<number>} Total stars.
 */
const totalStarsFetcher = async (username, include_orgs, repoToHide) => {
  let nodes = [];
  let hasNextPage = true;
  let endCursor = null;
  while (hasNextPage) {
    const variables = {
      login: username,
      first: 100,
      after: endCursor,
      ownerAffiliations: include_orgs ? ["OWNER", "COLLABORATOR"] : ["OWNER"],
    };
    let res = await retryer(repositoriesFetcher, variables);

    if (res.data.errors) {
      logger.error(res.data.errors);
      throw new CustomError(
        res.data.errors[0].message || "Could not fetch user",
        CustomError.USER_NOT_FOUND,
      );
    }

    const allNodes = res.data.data.user.repositories.nodes;
    const nodesWithStars = allNodes.filter(
      (node) => node.stargazers.totalCount !== 0,
    );
    nodes.push(...nodesWithStars);
    // hasNextPage =
    //   allNodes.length === nodesWithStars.length &&
    //   res.data.data.user.repositories.pageInfo.hasNextPage;
    hasNextPage = false; // NOTE: Temporarily disable fetching of multiple pages. Done because of #2130.
    endCursor = res.data.data.user.repositories.pageInfo.endCursor;
  }

  return nodes
    .filter((data) => !repoToHide[data.name])
    .reduce((prev, curr) => prev + curr.stargazers.totalCount, 0);
};

/**
 * Fetch stats for a given username.
 *
 * @param {string} username GitHub username.
 * @param {boolean} count_private Include private contributions.
 * @param {boolean} include_all_commits Include all commits.
 * @param {boolean} include_orgs Include stats from organization repos.
 * @returns {Promise<import("./types").StatsData>} Stats data.
 */
const fetchStats = async (
  username,
  count_private = false,
  include_all_commits = false,
  include_orgs = false,
  exclude_repo = [],
  ownerAffiliations = [],
) => {
  if (!username) throw new MissingParamError(["username"]);

  const stats = {
    name: "",
    totalPRs: 0,
    totalCommits: 0,
    totalIssues: 0,
    totalStars: 0,
    contributedTo: 0,
    rank: { level: "C", score: 0 },
  };
  ownerAffiliations = parseOwnerAffiliations(ownerAffiliations);

  let res = await retryer(fetcher, {
    login: username,
    ownerAffiliations: include_orgs ? ["OWNER", "COLLABORATOR"] : ["OWNER"],
  });

  // Catch GraphQL errors.
  if (res.data.errors) {
    logger.error(res.data.errors);
    if (res.data.errors[0].type === "NOT_FOUND") {
      throw new CustomError(
        res.data.errors[0].message || "Could not fetch user.",
        CustomError.USER_NOT_FOUND,
      );
    }
    if (res.data.errors[0].message) {
      throw new CustomError(
        wrapTextMultiline(res.data.errors[0].message, 90, 1)[0],
        res.statusText,
      );
    }
    throw new CustomError(
      "Something went while trying to retrieve the stats data using the GraphQL API.",
      CustomError.GRAPHQL_ERROR,
    );
  }

  const user = res.data.data.user;

  // populate repoToHide map for quick lookup
  // while filtering out
  let repoToHide = {};
  if (exclude_repo) {
    exclude_repo.forEach((repoName) => {
      repoToHide[repoName] = true;
    });
  }

  stats.name = user.name || user.login;
  stats.totalIssues = user.openIssues.totalCount + user.closedIssues.totalCount;

  // normal commits
  stats.totalCommits = user.contributionsCollection.totalCommitContributions;

  // if include_all_commits then just get that,
  // since totalCommitsFetcher already sends totalCommits no need to +=
  if (include_all_commits) {
    stats.totalCommits = await totalCommitsFetcher(username);
  }

  // if count_private then add private commits to totalCommits so far.
  if (count_private) {
    stats.totalCommits +=
      user.contributionsCollection.restrictedContributionsCount;
  }

  stats.totalPRs = user.pullRequests.totalCount;
  stats.contributedTo = user.repositoriesContributedTo.totalCount;

  // Retrieve stars while filtering out repositories to be hidden
  stats.totalStars = await totalStarsFetcher(
    username,
    include_orgs,
    repoToHide,
  );

  // @ts-ignore // TODO: Fix this.
  stats.rank = calculateRank({
    totalCommits: stats.totalCommits,
    totalRepos: user.repositories.totalCount,
    followers: user.followers.totalCount,
    contributions: stats.contributedTo,
    stargazers: stats.totalStars,
    prs: stats.totalPRs,
    issues: stats.totalIssues,
  });

  return stats;
};

export { fetchStats };
export default fetchStats;

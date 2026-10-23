
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    PermissionFlagsBits,
} = require("discord.js");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
    ],
});

// Locally, files are stored beside index.js.
// On Render, set DATA_DIR=/var/data and attach a persistent disk there.
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });

const HISTORY_FILE = path.join(DATA_DIR, "pairing-history.json");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");

// Load a JSON file, or return an empty object if it doesn't exist yet.
function loadJson(file) {
    try {
        if (!fs.existsSync(file)) {
            return {};
        }

        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        console.error(`Could not read ${file}:`, error);
        throw new Error(`Could not load ${path.basename(file)}.`);
    }
}

function saveJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

let history = loadJson(HISTORY_FILE);
let leaderboard = loadJson(LEADERBOARD_FILE);

function saveHistory() {
    saveJson(HISTORY_FILE, history);
}

function saveLeaderboard() {
    saveJson(LEADERBOARD_FILE, leaderboard);
}

// ---------------- SLASH COMMANDS ----------------

const every1sCommand = new SlashCommandBuilder()
    .setName("every1s")
    .setDescription("Randomly pair members without repeating previous pairs")
    .addStringOption(option =>
        option
            .setName("roles")
            .setDescription("Enter one or more role mentions")
            .setRequired(true)
    );



const submitCommand = new SlashCommandBuilder()
    .setName("submit")
    .setDescription("Submit a pair or trio for leaderboard points")
    .addUserOption(option =>
        option
            .setName("member1")
            .setDescription("First member")
            .setRequired(true)
    )
    .addUserOption(option =>
        option
            .setName("member2")
            .setDescription("Second member")
            .setRequired(true)
    )
    .addStringOption(option =>
        option
            .setName("location")
            .setDescription("Where did the activity take place?")
            .setRequired(true)
            .addChoices(
                { name: "Online (1 point)", value: "online" },
                { name: "On-campus (2 points)", value: "on-campus" },
                { name: "Off-campus (3 points)", value: "off-campus" }
            )
    )
    .addUserOption(option =>
        option
            .setName("member3")
            .setDescription("Third member (optional)")
            .setRequired(false)
    );



const leaderboardCommand = new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("View all players and their scores");

const resetCommand = new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Reset pairing history and leaderboard scores")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

const rest = new REST({ version: "10" })
    .setToken(process.env.DISCORD_TOKEN);

// ---------------- PAIRING FUNCTIONS ----------------

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }

    return array;
}

function pairKey(id1, id2) {
    return [id1, id2].sort().join(":");
}

// Each trio contributes all three two-person combinations.
function getGroupPairKeys(groups) {
    const keys = [];

    for (const group of groups) {
        for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
                keys.push(pairKey(group[i].id, group[j].id));
            }
        }
    }

    return keys;
}

function makeGroups(members) {
    const remaining = shuffle([...members]);
    const groups = [];

    if (remaining.length % 2 === 1 && remaining.length >= 3) {
        groups.push(remaining.splice(0, 3));
    }

    while (remaining.length >= 2) {
        groups.push(remaining.splice(0, 2));
    }

    if (remaining.length === 1) {
        groups.push(remaining.splice(0, 1));
    }

    return groups;
}

function generateUniqueGroups(members, usedPairs) {
    const MAX_ATTEMPTS = 10000;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const groups = makeGroups(members);
        const newPairs = getGroupPairKeys(groups);

        if (!newPairs.some(pair => usedPairs.has(pair))) {
            return { groups, newPairs };
        }
    }

    return null;
}

// ---------------- LEADERBOARD FUNCTIONS ----------------

// A submission is one unique pair or trio, regardless of member order.
function groupKey(memberIds) {
    return [...memberIds].sort().join(":");
}

function getGuildLeaderboard(guildId) {
    if (
        !leaderboard[guildId] ||
        Array.isArray(leaderboard[guildId])
    ) {
        leaderboard[guildId] = {
            submissions: [],
            scores: {},
        };
    }

    const data = leaderboard[guildId];

    if (!Array.isArray(data.submissions)) {
        data.submissions = [];
    }

    if (!data.scores || typeof data.scores !== "object") {
        data.scores = {};
    }

    return data;
}

function getRankedPlayers(guildId) {
    const data = getGuildLeaderboard(guildId);

    return Object.entries(data.scores)
        .map(([id, score]) => ({
            id,
            score,
        }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function formatLeaderboard(guildId) {
    const players = getRankedPlayers(guildId);

    if (players.length === 0) {
        return ["The leaderboard is empty. Use /submit to add points!"];
    }

    return players.map((player, index) => {
        return `**${index + 1}.** <@${player.id}> — **${player.score}** point${player.score === 1 ? "" : "s"}`;
    });
}

// Split long output into multiple messages to stay within Discord's limit.
async function sendLongReply(interaction, text) {
    const chunks = [];
    let current = "";

    for (const line of text.split("\n")) {
        if ((current + (current ? "\n" : "") + line).length > 1800) {
            if (current) chunks.push(current);
            current = "";
        }

        if (line.length > 1800) {
            if (current) chunks.push(current);
            current = "";
            for (let i = 0; i < line.length; i += 1800) {
                chunks.push(line.slice(i, i + 1800));
            }
        } else {
            current += (current ? "\n" : "") + line;
        }
    }

    if (current) chunks.push(current);

    await interaction.reply({
        content: chunks[0] || "No results.",
        allowedMentions: { parse: [] },
    });

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({
            content: chunks[i],
            allowedMentions: { parse: [] },
        });
    }
}

// ---------------- REGISTER COMMANDS ----------------

client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);

    try {
        await rest.put(
            Routes.applicationGuildCommands(
                process.env.CLIENT_ID,
                process.env.GUILD_ID
            ),
            {
                body: [
                    every1sCommand.toJSON(),
                    submitCommand.toJSON(),
                    leaderboardCommand.toJSON(),
                    resetCommand.toJSON(),
                ],
            }
        );

        console.log(
            "Registered /every1s, /submit, /leaderboard, and /reset."
        );
    } catch (error) {
        console.error("Command registration failed:", error);
    }
});

// ---------------- HANDLE COMMANDS ----------------

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    try {
        const guild = interaction.guild;

        if (!guild) {
            return interaction.reply({
                content: "Please use this command inside a Discord server.",
                ephemeral: true,
            });
        }

        // RESET: clear both pairing history and leaderboard for this server.
        if (interaction.commandName === "reset") {
            if (
                !interaction.memberPermissions?.has(
                    PermissionFlagsBits.ManageGuild
                )
            ) {
                return interaction.reply({
                    content: "You need Manage Server permission to reset.",
                    ephemeral: true,
                });
            }

            delete history[guild.id];
            delete leaderboard[guild.id];

            saveHistory();
            saveLeaderboard();

            return interaction.reply(
                "Pairing history and leaderboard have both been reset for this server."
            );
        }

        // SUBMIT: award one point to each member in a new pair or trio.
        if (interaction.commandName === "submit") {
            const members = [
                interaction.options.getUser("member1"),
                interaction.options.getUser("member2"),
                interaction.options.getUser("member3"),
            ].filter(Boolean);

            const ids = members.map(member => member.id);

            if (new Set(ids).size !== ids.length) {
                return interaction.reply({
                    content: "Please choose different members for the submission.",
                    ephemeral: true,
                });
            }

            if (members.some(member => member.bot)) {
                return interaction.reply({
                    content: "Bots cannot be included in submissions.",
                    ephemeral: true,
                });
            }

            const data = getGuildLeaderboard(guild.id);
            const key = groupKey(ids);

            if (data.submissions.includes(key)) {
                return interaction.reply({
                    content:
                        "That exact pair or trio has already been submitted. " +
                        "No additional points were awarded.",
                    ephemeral: true,
                });
            }

            // Ensure each submitted member belongs to this server.
            const fetchedMembers = await Promise.all(
                ids.map(id => guild.members.fetch(id).catch(() => null))
            );

            if (fetchedMembers.some(member => !member)) {
                return interaction.reply({
                    content: "All submitted members must belong to this server.",
                    ephemeral: true,
                });
            }

            // Get the selected location and determine points per member.
            const location = interaction.options.getString("location");

            const pointsByLocation = {
                online: 1,
                "on-campus": 2,
                "off-campus": 3,
            };

            const pointsEarned = pointsByLocation[location];

            if (!pointsEarned) {
                return interaction.reply({
                    content: "Please select a valid location.",
                    ephemeral: true,
                });
            }

            // Save the unique submission and award one point per member.
            data.submissions.push(key);

            for (const id of ids) {
                data.scores[id] = (data.scores[id] || 0) + pointsEarned;
            }

            saveLeaderboard();

            const submittedGroup = members
                .map(member => `<@${member.id}>`)
                .join(" + ");

            const updatedScores = members.map(member => {
                return `<@${member.id}>: **${data.scores[member.id]}** point${data.scores[member.id] === 1 ? "" : "s"}`;
            });

            const lines = [
                "## Submission accepted!",
                `**Group:** ${submittedGroup}`,
                `**Location:** ${location}`,
                `**Points earned per member:** ${pointsEarned}`,
                "",
                "**Updated scores:**",
                ...updatedScores,
                "",
                "## Current leaderboard",
                ...formatLeaderboard(guild.id),
            ];

            return sendLongReply(interaction, lines.join("\n"));
        }

        // LEADERBOARD: show every player, highest score first.
        if (interaction.commandName === "leaderboard") {
            const lines = [
                "## Leaderboard",
                ...formatLeaderboard(guild.id),
            ];

            return sendLongReply(interaction, lines.join("\n"));
        }

        // EVERY1S: generate groups without repeating previous pairs.
        if (interaction.commandName === "every1s") {
            await interaction.deferReply();

            const rolesInput = interaction.options.getString("roles");

            const roleIds = [
                ...new Set(
                    [...rolesInput.matchAll(/<@&(\d+)>/g)]
                        .map(match => match[1])
                ),
            ];

            if (roleIds.length === 0) {
                return interaction.editReply(
                    "Please provide at least one actual role mention."
                );
            }

            const selectedRoles = roleIds.map(id =>
                guild.roles.cache.get(id)
            );

            if (selectedRoles.some(role => !role)) {
                return interaction.editReply(
                    "One or more roles could not be found in this server."
                );
            }

            await guild.members.fetch();

            const selectedRoleIds = new Set(roleIds);

            const members = [...guild.members.cache.values()].filter(member =>
                !member.user.bot &&
                [...selectedRoleIds].some(roleId =>
                    member.roles.cache.has(roleId)
                )
            );

            if (members.length < 2) {
                return interaction.editReply(
                    `Only ${members.length} eligible member(s) found. ` +
                    "At least two members are needed."
                );
            }

            const usedPairs = new Set(history[guild.id] || []);

            const result = generateUniqueGroups(members, usedPairs);

            if (!result) {
                return interaction.editReply(
                    "I couldn't find a new grouping without repeated pairs " +
                    "after 10,000 attempts. Try adding members or use /reset " +
                    "to start a new pairing cycle."
                );
            }

            const { groups, newPairs } = result;

            history[guild.id] = [...usedPairs, ...newPairs];
            saveHistory();

            const lines = groups.map((group, index) => {
                const mentions = group
                    .map(member => `<@${member.id}>`)
                    .join(" + ");

                return `**Group ${index + 1}:** ${mentions}`;
            });

            return interaction.editReply({
                content: `**This Week's Every1s**\n${lines.join("\n")}`,
                allowedMentions: { parse: ["users"] },
            });
        }
    } catch (error) {
        console.error("Command error:", error);

        const message =
            "Something went wrong while processing the command. " +
            "Check the bot logs for details.";

        if (interaction.deferred) {
            await interaction.editReply(message).catch(console.error);
        } else if (!interaction.replied) {
            await interaction.reply({
                content: message,
                ephemeral: true,
            }).catch(console.error);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
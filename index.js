
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    PermissionFlagsBits
} = require("discord.js");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

// Pairing history is saved beside index.js.
const HISTORY_FILE = path.join(__dirname, "pairing-history.json");

// History is stored separately for each Discord server.
function loadHistory() {
    try {
        if (!fs.existsSync(HISTORY_FILE)) {
            return {};
        }

        return JSON.parse(
            fs.readFileSync(HISTORY_FILE, "utf8")
        );
    } catch (error) {
        console.error("Could not read pairing history:", error);
        throw new Error(
            "Pairing history could not be loaded. " +
            "Fix the history file before generating new groups."
        );
    }
}

function saveHistory(history) {
    fs.writeFileSync(
        HISTORY_FILE,
        JSON.stringify(history, null, 2),
        "utf8"
    );
}

let history = loadHistory();

// Define slash commands
const every1sCommand = new SlashCommandBuilder()
    .setName("every1s")
    .setDescription("Randomly pair members without repeating previous pairs")
    .addStringOption(option =>
        option
            .setName("roles")
            .setDescription("Enter one or more role mentions")
            .setRequired(true)
    );

const resetCommand = new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Reset all saved pairing history")
    .setDefaultMemberPermissions(
        PermissionFlagsBits.ManageGuild
    );

const rest = new REST({ version: "10" })
    .setToken(process.env.DISCORD_TOKEN);

// Shuffle an array randomly
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }

    return array;
}

// Generate a consistent key for an unordered pair.
// A + B and B + A produce the same key.
function pairKey(id1, id2) {
    return [id1, id2].sort().join(":");
}

// Get every two-person combination inside every group.
// A group of three contributes three pair keys.
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

// Create groups with the original pairing rules:
// odd number >= 3: one group of three;
// remaining members: groups of two.
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

// Try to find a grouping with no previously used pairs.
function generateUniqueGroups(members, usedPairs) {
    const MAX_ATTEMPTS = 10000;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const groups = makeGroups(members);
        const newPairs = getGroupPairKeys(groups);

        const hasRepeatedPair = newPairs.some(pair =>
            usedPairs.has(pair)
        );

        if (!hasRepeatedPair) {
            return {
                groups,
                newPairs
            };
        }
    }

    return null;
}

// Register both slash commands when the bot starts.
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
                    resetCommand.toJSON()
                ]
            }
        );

        console.log("Registered /every1s and /reset.");
    } catch (error) {
        console.error("Command registration failed:", error);
    }
});

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // RESET COMMAND
    if (interaction.commandName === "reset") {
        if (
            !interaction.memberPermissions?.has(
                PermissionFlagsBits.ManageGuild
            )
        ) {
            return interaction.reply({
                content: "You need Manage Server permission to reset history.",
                ephemeral: true
            });
        }

        // Clear history for this server only.
        history[interaction.guildId] = [];
        saveHistory(history);

        return interaction.reply(
            "Pairing history has been reset! " +
            "Previous pairs can now occur again."
        );
    }

    // EVERY1S COMMAND
    if (interaction.commandName !== "every1s") return;

    await interaction.deferReply();

    try {
        const guild = interaction.guild;

        if (!guild) {
            return interaction.editReply(
                "This command must be used in a server."
            );
        }

        // Extract role IDs from role mentions.
        const rolesInput = interaction.options.getString("roles");

        const roleIds = [
            ...new Set(
                [...rolesInput.matchAll(/<@&(\d+)>/g)]
                    .map(match => match[1])
            )
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

        // Fetch the current members and their roles.
        await guild.members.fetch();

        // Include anyone with ANY selected role, only once.
        const selectedRoleIds = new Set(roleIds);

        const members = [
            ...guild.members.cache.values()
        ].filter(member =>
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

        // Get previously used pairs for this server.
        const usedPairs = new Set(
            history[guild.id] || []
        );

        // Find a new grouping without repeated pairs.
        const result = generateUniqueGroups(
            members,
            usedPairs
        );

        if (!result) {
            return interaction.editReply(
                "I couldn't find a new grouping without repeated pairs " +
                "after 10,000 attempts. The available members may not " +
                "allow another arrangement. Try adding members or use " +
                "/reset to start a new pairing cycle."
            );
        }

        const { groups, newPairs } = result;

        // Save only after a valid grouping has been found.
        history[guild.id] = [
            ...usedPairs,
            ...newPairs
        ];

        saveHistory(history);

        // Format the results with Discord mentions.
        const lines = groups.map((group, index) => {
            const mentions = group
                .map(member => `<@${member.id}>`)
                .join(" + ");

            return `**Group ${index + 1}:** ${mentions}`;
        });

        await interaction.editReply({
            content:
                `**This Week's Every1s**\n` +
                lines.join("\n"),
            allowedMentions: {
                parse: ["users"]
            }
        });

    } catch (error) {
        console.error("Error generating groups:", error);

        await interaction.editReply(
            "Something went wrong while generating groups. " +
            "Check the bot console for details."
        );
    }
});

client.login(process.env.DISCORD_TOKEN);

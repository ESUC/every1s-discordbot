
require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes
} = require("discord.js");

// Initialize the Discord bot
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

// Define the slash command
const command = new SlashCommandBuilder()
    .setName("every1s")
    .setDescription("Randomly pair members from selected roles")
    .addStringOption(option =>
        option
            .setName("roles")
            .setDescription(
                "Enter one or more role mentions, e.g. @Board @Interns"
            )
            .setRequired(true)
    );

// Register the slash command for your server
const rest = new REST({ version: "10" })
    .setToken(process.env.DISCORD_TOKEN);

// Randomly shuffle an array using Fisher-Yates
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));

        [array[i], array[j]] = [array[j], array[i]];
    }

    return array;
}

// Create random groups
function makeGroups(members) {
    shuffle(members);

    const groups = [];

    // If the number is odd, create one group of 3
    if (members.length % 2 === 1 && members.length >= 3) {
        groups.push(members.splice(0, 3));
    }

    // Pair the remaining members
    while (members.length >= 2) {
        groups.push(members.splice(0, 2));
    }

    // If only one member remains, put them in a group alone
    if (members.length === 1) {
        groups.push(members.splice(0, 1));
    }

    return groups;
}

// When the bot starts
client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);

    try {
        await rest.put(
            Routes.applicationGuildCommands(
                process.env.CLIENT_ID,
                process.env.GUILD_ID
            ),
            {
                body: [command.toJSON()]
            }
        );

        console.log("Registered /every1s successfully.");
    } catch (error) {
        console.error("Failed to register command:", error);
    }
});

// Handle slash commands
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "every1s") return;

    await interaction.deferReply();

    try {
        const guild = interaction.guild;

        if (!guild) {
            return interaction.editReply(
                "This command must be used in a server."
            );
        }

        // Get the role mentions supplied by the user
        const rolesInput = interaction.options.getString("roles");

        // Extract role IDs from mentions: <@&123456789012345678>
        const roleIds = [
            ...new Set(
                [...rolesInput.matchAll(/<@&(\d+)>/g)]
                    .map(match => match[1])
            )
        ];

        if (roleIds.length === 0) {
            return interaction.editReply(
                "Please provide at least one role mention. " +
                "Example: <@&123456789012345678>"
            );
        }

        // Verify that every role belongs to this server
        const selectedRoles = roleIds.map(id =>
            guild.roles.cache.get(id)
        );

        if (selectedRoles.some(role => !role)) {
            return interaction.editReply(
                "One or more roles could not be found in this server."
            );
        }

        // Fetch current server members
        await guild.members.fetch();

        const selectedRoleIds = new Set(roleIds);

        // Include members with ANY selected role.
        // A member with multiple selected roles is included only once.
        // Bots are excluded.
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

        // Generate random groups
        const groups = makeGroups([...members]);

        // Format each group using Discord mentions
        const lines = groups.map((group, index) => {
            const mentions = group
                .map(member => `<@${member.id}>`)
                .join(" + ");

            return `**Group ${index + 1}:** ${mentions}`;
        });

        const roleNames = selectedRoles
            .map(role => role.name)
            .join(", ");

        const message =
            `**This Week's Every1s**\n` +
            `**Roles:** ${roleNames}\n\n` +
            lines.join("\n");

        await interaction.editReply({
            content: message,
            allowedMentions: {
                parse: ["users"]
            }
        });

    } catch (error) {
        console.error("Error generating groups:", error);

        await interaction.editReply(
            "Something went wrong while generating the groups."
        );
    }
});

// Log in to Discord
client.login(process.env.DISCORD_TOKEN);

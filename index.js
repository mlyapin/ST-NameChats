/* FIXME: Repro:
 * 1. Choose None as profile in ST.
 * 2. Chose any profile, other than 'same as current' in the extension.
 * 3. Trigger renaming.
 * 4. Extension profile will be set as an active in ST now. */

import { generateRaw } from '../../../../script.js'
import { saveMetadataDebounced } from '../../../extensions.js'
const {
  getCurrentChatId,
  renameChat,
  chatMetadata,
  eventTypes,
  eventSource,
  ConnectionManagerRequestService,
  humanizedDateTime,
  renderExtensionTemplateAsync,
} = SillyTavern.getContext();

const MODULE_NAME = 'ChatAutoTitle';

const defaultPrompts = {
  generateTitle: "Suggest a concise title for the following dialogue between a user and an AI assistant. Dont write anything other than the title.",
  selectedProfile: 'current',
};

let currentPrompts = { ...defaultPrompts };

async function saveChatAutoTitleSettings() {
  const chatSpecificSettings = chatMetadata[MODULE_NAME] || {};
  chatSpecificSettings.prompts = { ...currentPrompts };
  chatMetadata[MODULE_NAME] = chatSpecificSettings;
  saveMetadataDebounced();
  console.log(`${MODULE_NAME}: Settings saved`);
}

async function loadChatAutoTitleSettings() {
  const chatSpecificSettings = chatMetadata[MODULE_NAME];
  if (chatSpecificSettings && chatSpecificSettings.prompts) {
    currentPrompts = { ...defaultPrompts, ...chatSpecificSettings.prompts };
  } else {
    currentPrompts = { ...defaultPrompts };
  }

  console.log(`${MODULE_NAME}: Settings loaded. Current prompt: "${currentPrompts.generateTitle}", Selected Profile: "${currentPrompts.selectedProfile}"`);

  // Update UI if available
  const generatePromptTextarea = jQuery('#objective-prompt-generate-main');
  if (generatePromptTextarea.length) {
    generatePromptTextarea.val(currentPrompts.generateTitle);
  }

  updateConnectionProfileDropdown();
}

async function doRenameChat(args) {
  const currentChatName = getCurrentChatId();
  if (!currentChatName) throw new Error('Cannot rename: no chat ID');
  if (!args?.title || args.title.length < 1) {
    throw new Error('Invalid title');
  }
  const newChatName = `${humanizedDateTime()} - ${args.title.trim()}`;
  await renameChat(currentChatName, newChatName);
  return { title: newChatName };
}

function getConnectionProfiles() {
  const ctx = SillyTavern.getContext();
  const connectionProfileNames = ctx.extensionSettings.connectionManager.profiles.map(x => x.name);
  return connectionProfileNames;
}

function updateConnectionProfileDropdown() {
  const connectionProfileSelect = $("#chat-auto-title-connection-profile");
  const connectionProfiles = getConnectionProfiles();
  console.log(`${MODULE_NAME}: connections profiles found`, connectionProfiles);
  connectionProfileSelect.empty();
  connectionProfileSelect.append($("<option>").val("current").text("Same as current"));
  for (const profileName of connectionProfiles) {
    const option = $("<option>").val(profileName).text(profileName);

    if (profileName === currentPrompts.selectedProfile) {
      option.attr("selected", "selected");
    }

    connectionProfileSelect.append(option);
  }
}

function onConnectionProfileSelectChange() {
  const selectedProfile = $(this).val();
  currentPrompts.selectedProfile = selectedProfile;
  console.log(`${MODULE_NAME}: Selected profile:`, selectedProfile);
  saveChatAutoTitleSettings();
}


jQuery(async () => {
  // Load settings UI
  try {
    const settingsHtml = await renderExtensionTemplateAsync('third-party/SillyTavern-NameChats', 'settings');
    const settingsContainer = jQuery('#extensions_settings');
    if (settingsContainer.length) {
      settingsContainer.append(settingsHtml);
    } else {
      const fallbackContainer = jQuery('<div id="chat_auto_title_settings_container"></div>').appendTo('body');
      fallbackContainer.append(settingsHtml);
    }
    await loadChatAutoTitleSettings();
  } catch (error) {
    console.error(`${MODULE_NAME}: Failed to load settings UI:`, error);
    await loadChatAutoTitleSettings();
  }

  // Settings change handler
  jQuery(document).on('input', '#objective-prompt-generate-main', function() {
    currentPrompts.generateTitle = jQuery(this).val();
    saveChatAutoTitleSettings();
  });

  // Connection profile change handler
  jQuery(document).on('change', '#chat-auto-title-connection-profile', onConnectionProfileSelectChange);


  // Reload settings when chat changes
  eventSource.on(eventTypes.CHAT_CHANGED, async () => {
    console.log(`${MODULE_NAME}: Chat changed - reloading settings`);
    await loadChatAutoTitleSettings();
  });

  // Main title generation logic
  eventSource.on(eventTypes.GENERATE_AFTER_DATA, async () => {
    const ctx = SillyTavern.getContext();

    if (ctx.chat.length === 1) {
      try {
        const promptForTitleLLM = currentPrompts.generateTitle;
        console.log(`${MODULE_NAME}: Generating title with prompt: "${promptForTitleLLM}"`);

        // Save current active profile to restore later
        const connectionManagerSettings = ctx.extensionSettings.connectionManager;
        const preselectedProfileId = connectionManagerSettings.selectedProfile;
        const preselectedProfileName = connectionManagerSettings.profiles.find(x => x.id === preselectedProfileId)?.name;

        // Switch to selected profile if not using current
        if (currentPrompts.selectedProfile !== 'current') {
          console.log(`${MODULE_NAME}: Switching to profile ${currentPrompts.selectedProfile}`);
          await ctx.executeSlashCommandsWithOptions(`/profile ${currentPrompts.selectedProfile}`);
        }

        // Generate title using current or switched profile
        const maxResponseToken = 50;
        const llmGeneratedTitle = await generateRaw(
          promptForTitleLLM,
          null,
          false,
          false,
          "",
          maxResponseToken
        );
        console.log(`${MODULE_NAME}: Generated title: "${llmGeneratedTitle}"`);

        // Restore previous profile if switched
        if (currentPrompts.selectedProfile !== 'current' && preselectedProfileName) {
          console.log(`${MODULE_NAME}: Reverting to profile ${preselectedProfileName}`);
          await ctx.executeSlashCommandsWithOptions(`/profile ${preselectedProfileName}`);
        }

        if (llmGeneratedTitle && llmGeneratedTitle.trim().length > 0) {
          await doRenameChat({ title: llmGeneratedTitle.trim() });
          console.log(`${MODULE_NAME}: Chat renamed successfully`);
        } else {
          console.error(`${MODULE_NAME}: Empty title generated`);
        }
      } catch (e) {
        console.error(`${MODULE_NAME}: Title generation failed:`, e);
        // Ensure profile is restored even if generation fails
        if (currentPrompts.selectedProfile !== 'current') {
          const connectionManagerSettings = ctx.extensionSettings.connectionManager;
          const preselectedProfileId = connectionManagerSettings.selectedProfile;
          const preselectedProfileName = connectionManagerSettings.profiles.find(x => x.id === preselectedProfileId)?.name;
          if (preselectedProfileName) {
            console.log(`${MODULE_NAME}: Reverting to profile ${preselectedProfileName} after error`);
            await ctx.executeSlashCommandsWithOptions(`/profile ${preselectedProfileName}`);
          }
        }
      }
    }
  });
});

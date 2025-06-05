/* FIXME: Repro:
 * 1. Choose None as profile in ST.
 * 2. Chose any profile, other than 'same as current' in the extension.
 * 3. Trigger renaming.
 * 4. Extension profile will be set as an active in ST now. */

import { generateRaw } from '../../../../script.js'
import { extension_settings } from '../../../extensions.js'
const {
  getCurrentChatId,
  renameChat,
  chatMetadata,
  eventTypes,
  eventSource,
  ConnectionManagerRequestService,
  saveSettingsDebounced,
  humanizedDateTime,
  renderExtensionTemplateAsync,
} = SillyTavern.getContext();

const MODULE_NAME = 'ChatAutoTitle';

const defaultSettings = {
  generateTitle: "Suggest a concise title for the following dialogue between a user and an AI assistant. Don't write anything other than the title.",
  selectedProfile: 'current',
  maxResponseToken: 50,
};

let extensionSettings = extension_settings[MODULE_NAME];

const initSettings = async () => {
  if (!extensionSettings || extensionSettings == {}) {
    extension_settings[MODULE_NAME] = defaultSettings;
    extensionSettings = defaultSettings;
    saveSettingsDebounced();
  } else if (extensionSettings.generateTitle == undefined) {
    extension_settings[MODULE_NAME] = { ...defaultSettings, ...extensionSettings };
    extensionSettings = extension_settings[MODULE_NAME];
    saveSettingsDebounced();
  }
};

async function saveChatAutoTitleSettings() {
  saveSettingsDebounced();
  console.log(`${MODULE_NAME}: Settings saved`);
}

async function loadChatAutoTitleSettings() {
  console.log(`${MODULE_NAME}: Settings loaded. Current prompt: "${extensionSettings.generateTitle}", Selected Profile: "${extensionSettings.selectedProfile}", Max Response Tokens: ${extensionSettings.maxResponseToken}`);

  // Update UI if available
  const generatePromptTextarea = jQuery('#objective-prompt-generate-main');
  if (generatePromptTextarea.length) {
    generatePromptTextarea.val(extensionSettings.generateTitle);
  }

  const maxTokensInput = jQuery('#chat-auto-title-max-tokens');
  if (maxTokensInput.length) {
    maxTokensInput.val(extensionSettings.maxResponseToken);
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

    if (profileName === extensionSettings.selectedProfile) {
      option.attr("selected", "selected");
    }

    connectionProfileSelect.append(option);
  }
}

function onConnectionProfileSelectChange() {
  const selectedProfile = $(this).val();
  extensionSettings.selectedProfile = selectedProfile;
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
    await initSettings();
    await loadChatAutoTitleSettings();
  } catch (error) {
    console.error(`${MODULE_NAME}: Failed to load settings UI:`, error);
    await loadChatAutoTitleSettings();
  }

  // Settings change handler
  jQuery(document).on('input', '#objective-prompt-generate-main', function() {
    extensionSettings.generateTitle = jQuery(this).val();
    saveChatAutoTitleSettings();
  });

  // Max tokens change handler
  jQuery(document).on('input', '#chat-auto-title-max-tokens', function() {
    const value = parseInt(jQuery(this).val());
    if (!isNaN(value) && value > 0) {
      extensionSettings.maxResponseToken = value;
      saveChatAutoTitleSettings();
    }
  });

  // Connection profile change handler
  jQuery(document).on('change', '#chat-auto-title-connection-profile', onConnectionProfileSelectChange);


  // Reload settings when chat changes
  eventSource.on(eventTypes.CHAT_CHANGED, async () => {
    console.log(`${MODULE_NAME}: Chat changed - reloading settings`);
    await loadChatAutoTitleSettings();
  });

  // Helper function to check if this is the first user message and we haven't renamed yet
  function shouldGenerateTitle(chat) {
    // Find the first message with is_user: true
    const firstUserMessageIndex = chat.findIndex(message => message.is_user === true);

    // If no user message found, return false
    if (firstUserMessageIndex === -1) {
      return false;
    }
    
    // Count how many user messages exist
    const userMessageCount = chat.filter(message => message.is_user === true).length;
    
    // Only proceed if there's exactly 1 user message
    if (userMessageCount !== 1) {
      return false;
    }
    
    // Check if we've already renamed this chat by looking for our flag in the first user message
    const firstUserMessage = chat[firstUserMessageIndex];
    if (firstUserMessage.extra && firstUserMessage.extra.chatAutoTitleGenerated) {
      return false; // Already renamed
    }
    
    return true; // Should generate title
  }

  // Helper function to mark that we've generated a title for this chat
  function markTitleGenerated(chat) {
    const firstUserMessageIndex = chat.findIndex(message => message.is_user === true);
    if (firstUserMessageIndex !== -1) {
      const firstUserMessage = chat[firstUserMessageIndex];
      if (!firstUserMessage.extra) {
        firstUserMessage.extra = {};
      }
      firstUserMessage.extra.chatAutoTitleGenerated = true;
      
      // Save the chat to persist the flag
      const ctx = SillyTavern.getContext();
      ctx.saveChat();
    }
  }

  // Main title generation logic
  eventSource.on(eventTypes.GENERATE_AFTER_DATA, async () => {
    const ctx = SillyTavern.getContext();

    if (shouldGenerateTitle(ctx.chat)) {
      try {
        const promptForTitleLLM = extensionSettings.generateTitle;
        console.log(`${MODULE_NAME}: Generating title with prompt: "${promptForTitleLLM}"`);

        // Save current active profile to restore later
        const connectionManagerSettings = ctx.extensionSettings.connectionManager;
        const preselectedProfileId = connectionManagerSettings.selectedProfile;
        const preselectedProfileName = connectionManagerSettings.profiles.find(x => x.id === preselectedProfileId)?.name;

        // Switch to selected profile if not using current
        if (extensionSettings.selectedProfile !== 'current') {
          console.log(`${MODULE_NAME}: Switching to profile ${extensionSettings.selectedProfile}`);
          await ctx.executeSlashCommandsWithOptions(`/profile ${extensionSettings.selectedProfile}`);
        }

        // Generate title using current or switched profile
        const llmGeneratedTitle = await generateRaw(
          promptForTitleLLM,
          null,
          false,
          false,
          "",
          extensionSettings.maxResponseToken
        );
        console.log(`${MODULE_NAME}: Generated title: "${llmGeneratedTitle}"`);

        // Restore previous profile if switched
        if (extensionSettings.selectedProfile !== 'current' && preselectedProfileName) {
          console.log(`${MODULE_NAME}: Reverting to profile ${preselectedProfileName}`);
          await ctx.executeSlashCommandsWithOptions(`/profile ${preselectedProfileName}`);
        }

        if (llmGeneratedTitle && llmGeneratedTitle.trim().length > 0) {
          await doRenameChat({ title: llmGeneratedTitle.trim() });
          markTitleGenerated(ctx.chat);
          console.log(`${MODULE_NAME}: Chat renamed successfully`);
        } else {
          console.error(`${MODULE_NAME}: Empty title generated`);
        }
      } catch (e) {
        console.error(`${MODULE_NAME}: Title generation failed:`, e);
        // Ensure profile is restored even if generation fails
        if (extensionSettings.selectedProfile !== 'current') {
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

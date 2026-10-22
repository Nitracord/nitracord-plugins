# Settings pages

Use the shared page builder to give your plugin the same rows, controls and colors as Nitracord and Discord. Require `Nitracord.ui.apiVersion >= 1` and `ui.createPage` before registering your settings tool.

```js
const dc = Nitracord;
const Settings = dc.ui.createPage(function Settings() {
  const [enabled, setEnabled] = dc.React.useState(true);
  return {
    title: "My Plugin",
    sections: [{
      title: "Preferences",
      rows: [{
        type: "switch",
        title: "Enable feature",
        description: "Apply this feature to new messages.",
        value: enabled,
        onValueChange: setEnabled,
      }],
    }],
  };
});
const unregister = dc.registerTool({
  id: "my-plugin-settings",
  title: "My Plugin",
  open() { dc.ui.present(dc.React.createElement(Settings)); },
});
```

Create the component once, outside `open`. Hooks belong inside its definition callback. State in this example lasts while the page is mounted; use [scoped storage](bridge-api.md#scoped-storage) for settings that must survive closing the page or restarting Discord. Keep the tool disposer for your plugin's `stop` function.

| Row type | Fields |
| --- | --- |
| `info` (default) | `title`, optional `description` and `trailing` React element. |
| `action` | `title`, `onPress`, optional `description`, `disabled`, `danger`. |
| `switch` | `title`, `value`, `onValueChange`, optional `description`, `disabled`. |
| `radio` | `title`, `selected`, `onPress`, optional `description`, `disabled`. The entire row selects the option. |
| `input` | `title`, string `value`, `onChangeText`, optional `placeholder`, `keyboardType`, `disabled`. |

Give sections and rows stable `id` values when their order can change. A section accepts `title`, `description` and `rows`. Event callbacks own validation, persistence, asynchronous errors and any destructive-action confirmation; the builder does not perform those actions automatically.

For custom content, use the same components directly:

```js
return dc.React.createElement(dc.ui.Page, { title: "My Plugin" },
  dc.React.createElement(dc.ui.Section, { title: "Preferences" },
    dc.React.createElement(dc.ui.Row, {
      type: "switch", title: "Enable feature", value: enabled,
      onValueChange: setEnabled,
    }),
  ),
);
```

`ui.Page` supplies the header, system insets, background and scroll container. Set `scroll: false` when supplying your own scroll view. `onBack` overrides the header action, for example to confirm stopping an active operation. `ui.Field` and `ui.Text` support custom layouts; `ui.Text` accepts `muted`, `size` and `style`. Read `ui.colors()` for additional content instead of copying a dark palette or hardcoding an accent.

Rows and groups use Discord's loaded `TableRow` and `TableRowGroup`; switches and radio indicators use `FormSwitch` and `FormRadio`. Nitracord forwards the settings theme and accessibility context to its page host. The palette comes from Discord's semantic colors, then applies the current custom theme. Unavailable or incompatible components use shared fallbacks. Plugins should use the public API rather than discovering those components themselves.

`ui.present(element)` opens a child page. Header Back and Android Back return to its parent; closing the outer page returns to Discord. Opening a plugin from Plugins therefore returns to Plugins. Pages can unmount during navigation: keep durable state in your plugin or storage rather than relying on the page remaining mounted.

See the runnable [settings page example](../examples/settings-page.js) and the [bridge API reference](bridge-api.md).
